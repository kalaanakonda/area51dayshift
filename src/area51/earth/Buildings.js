import { BufferAttribute, BufferGeometry, DataTexture, FloatType, Frustum, Group, Matrix4, Mesh, NearestFilter, RGBAFormat, ShaderMaterial, Sphere, Vector3 } from 'three';
import { GLSL_ATMO } from './atmosphere.js';
import { TERRARIUM } from './Earth.js';

/**
 * 3D buildings for the free Earth (Google's photorealistic tiles already have
 * them): OpenStreetMap footprints from OpenFreeMap's OpenMapTiles vector
 * tiles, extruded to their mapped heights.
 *
 * Streamed the way open-world games stream a city, so it is already standing
 * when you look at it:
 *   • a draw distance — every building within 3 km, the skyline (tall
 *     buildings, big halls) out to 6 km — fetched in the order you'll need
 *     it: what's in view first, nearest first, aimed a few seconds ahead
 *   • LOD per tile: far tiles carry only their skyline and fill in as you
 *     approach; near ones go back to it as you leave (memory stays flat)
 *   • each building dithers in and out at the edge of its range on its own,
 *     so no tile edge or detail switch ever shows
 *   • each tile brings its own ground heights — nothing waits on the terrain
 *   • a warp streams the city at the far end while you're in the tunnel
 * Fetching, decoding and extrusion happen in a worker; the main thread turns
 * at most one tile per frame into a mesh.
 *
 * Shading is all per vertex — sun, sky, ground bounce and haze from the shared
 * atmosphere model. Every face is flat, so that is exact for the light; and a
 * city is millions of overlapping faces that the logarithmic depth buffer
 * shades whether hidden or not, so the fragment shader must cost next to nothing.
 */
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const Z = 14;
const NEAR_R = 3000; // m: every building within this
const FAR_R = 6000; // m: the skyline out to this
const NEAR_EDGE = 600; // m over which the low-rise thins out
const FAR_EDGE = 900; // m over which the skyline does
const LOOKAHEAD = 5; // s of travel the streaming aims ahead
const IN_FLIGHT = 6; // tile requests at once (mostly waiting on the network)
const FADE = 0.8; // s for a new tile to dither in
const TEX_W = 1024; // per-building data texture width
const BUDGET = 1.0; // ms per frame re-seating near tiles on the rendered terrain
const RESEAT = 1200; // most buildings re-sampled per pass
const DEG = Math.PI / 180;
export const BUILDINGS_ATTRIBUTION = 'Buildings © OpenStreetMap contributors · OpenMapTiles · OpenFreeMap';

const f = (v) => v.toFixed(1);

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  ${GLSL_ATMO}
  attribute float aBld;
  uniform highp sampler2D uBld;
  uniform int uBldW;
  uniform float uClock;
  uniform float uBorn;
  uniform float uFadeFrom;
  uniform float uLodCount;
  varying vec3 vCol;
  varying vec3 vIns;
  varying vec3 vTr;
  varying float vFade;

  void main() {
    int bi = int(aBld + 0.5);
    vec4 bd = texelFetch(uBld, ivec2(bi % uBldW, bi / uBldW), 0); // ground, centre x, centre z (tile-local)
    vec3 U = normalize(modelMatrix[1].xyz);

    // Draw distance, per building (measured to its centre, so it goes as one): the
    // low-rise thins out toward the edge of the detail ring, the skyline toward the
    // edge of the city. New tiles dither in, except what they took over from a far tile.
    vec3 toB = (vec4((modelViewMatrix * vec4(bd.y, bd.x, bd.z, 1.0)).xyz, 0.0) * viewMatrix).xyz;
    float range = length(toB - U * dot(toB, U));
    bool sky = aBld < uLodCount;
    float reach = sky ? ${f(FAR_R)} : ${f(NEAR_R)};
    float edge = sky ? ${f(FAR_EDGE)} : ${f(NEAR_EDGE)};
    vFade = (1.0 - smoothstep(reach - edge, reach, range)) * (aBld < uFadeFrom ? 1.0 : clamp((uClock - uBorn) / ${f(FADE)}, 0.0, 1.0));
    if (vFade <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // out of range or not in yet: outside the clip volume, no fragments
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position.x, bd.x + position.y, position.z, 1.0);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>

    // sun + sky + light bounced off the ground, the way the relit terrain gets it
    vec3 N = normalize(mat3(modelMatrix) * normal);
    float mu = dot(U, uA51Sun);
    vec3 tSun = a51SunTransmittance(0.0, mu);
    float day = smoothstep(-0.035, 0.06, mu);
    vec3 skyL = vec3(0.16, 0.2, 0.28) * smoothstep(-0.16, 0.3, mu) * (0.35 + 0.65 * tSun.g);
    vec3 bounce = (tSun * max(mu, 0.0) * day + skyL) * 0.2;
    float nu = dot(N, U);
    vec3 E = tSun * max(dot(N, uA51Sun), 0.0) * day + skyL * (0.5 + 0.5 * nu) + bounce * (0.5 - 0.5 * nu);
    vCol = color * (E * uA51SunI * RECIPROCAL_PI + vec3(0.0006, 0.0008, 0.0014));

    // aerial perspective (it changes slowly across one building)
    vIns = vec3(0.0);
    vTr = vec3(1.0);
    float tm = length(mv.xyz);
    if (tm > 40.0) {
      vec3 rd = normalize((vec4(mv.xyz, 0.0) * viewMatrix).xyz);
      a51Scatter(uA51Cam, rd, tm / uA51PlanetR, 6, vIns, vTr);
      vTr = mix(vec3(1.0), vTr, uA51Haze);
      vIns *= uA51Haze;
    }
  }
`;

const FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vCol;
  varying vec3 vIns;
  varying vec3 vTr;
  varying float vFade;

  void main() {
    // dithering in or out (interleaved gradient noise); settled buildings never get here
    if (vFade < 1.0 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) >= vFade) discard;
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(vCol * vTr + vIns, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const _o = new Vector3();
const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();
const _s = new Vector3();
const _m = new Matrix4();
const _sphere = new Sphere();

/** Fractional z14 tile coordinates. */
function tileXY(lat, lon) {
  const n = 2 ** Z;
  const la = Math.max(-85.05, Math.min(85.05, lat)) * DEG;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n];
}

function tileCentre(x, y) {
  const n = 2 ** Z;
  return [Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) / DEG, ((x + 0.5) / n) * 360 - 180];
}

/** Distance in tiles from point p to tile (x, y) — 0 inside it. */
const gap = (x, y, p) => Math.hypot(Math.max(x - p[0], 0, p[0] - x - 1), Math.max(y - p[1], 0, p[1] - y - 1));

/** Once the GPU has a buffer nothing reads it here again: let the JS copy go. */
function dropArray() {
  this.array = null;
}

export class Buildings {
  /** exclude: [{ lat, lon, r (m) }] — no OSM buildings there (our own hangar stands on the real site). */
  constructor({ frame, earth, camera, atmoUniforms, exclude = [] }) {
    this.frame = frame;
    this.earth = earth;
    this.camera = camera;
    this.atmoU = atmoUniforms;
    this.exclude = exclude;
    this.group = new Group();
    this.group.name = 'buildings';
    this.enabled = earth.mode === 'free' && typeof Worker !== 'undefined';
    this.tiles = new Map();
    this.clock = { value: 0 }; // shared by every building material
    this.inflight = 0;
    this.resampleT = 0;
    this.template = null;
    this.stats = { tiles: 0, buildings: 0 };
    this.frustum = new Frustum();
    this._seq = 0;
    this._ground = 0; // terrain height under the craft, for placing tiles in the view test
    this._last = null; // previous fractional tile position, for the ground velocity
    this._vel = [0, 0]; // tiles/s
    if (this.enabled) this._init();
  }

  get active() {
    return this.enabled && this.stats.buildings > 0;
  }

  async _init() {
    try {
      const j = await (await fetch(TILEJSON)).json();
      this.template = j.tiles[0];
    } catch (err) {
      console.warn('[buildings] tile index unavailable', err);
      this.enabled = false;
      return;
    }
    this.worker = new Worker(new URL('./buildings.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._received(e.data);
  }

  /** where = { lat, lon (deg), agl, speed, busy (warping), dest ({ lat, lon } while a warp is under way) } */
  update(dt, where) {
    this.clock.value += dt;
    if (!this.enabled || !this.template) return;
    const here = tileXY(where.lat, where.lon);
    this._track(here, dt);
    const dest = where.dest ? tileXY(where.dest.lat, where.dest.lon) : null;
    const w = (40075016.686 * Math.cos((dest ? where.dest.lat : where.lat) * DEG)) / 2 ** Z; // tile width where it matters, m

    // Where the city is wanted: around the craft and a few seconds ahead of it —
    // or, warping, around the destination, which streams in while you're in the tunnel.
    let foci = [];
    if (dest) foci = [dest];
    else if (where.agl < 3500 && where.speed < 1400 && !where.busy) {
      const v = Math.hypot(this._vel[0], this._vel[1]);
      const lead = v > 1e-4 ? Math.min(2, v * LOOKAHEAD) / v : 0; // at most two tiles ahead
      foci = [here, [here[0] + this._vel[0] * lead, here[1] + this._vel[1] * lead]];
    }
    const reach = (t, pts) => {
      let d = Infinity;
      for (const p of pts) d = Math.min(d, gap(t.x, t.y, p));
      return d * w;
    };
    const want = (t) => {
      const d = reach(t, foci);
      return d < NEAR_R ? 'near' : d < FAR_R ? 'far' : null;
    };

    // out of range: dropped; a near tile beyond the detail ring is drawn down to its skyline
    const keep = dest ? [here, ...foci] : foci.length ? foci : [here];
    for (const [key, t] of this.tiles) {
      t.d = reach(t, keep);
      if (t.d > FAR_R + w || (!t.level && !t.pending && !want(t))) this._drop(key, t);
      else if (t.mesh) this._detail(t, t.d < NEAR_R + 300);
    }
    const span = Math.ceil(FAR_R / w) + 1;
    for (const p of foci) {
      const fx = Math.floor(p[0]);
      const fy = Math.floor(p[1]);
      for (let y = fy - span; y <= fy + span; y++) {
        for (let x = fx - span; x <= fx + span; x++) {
          if (gap(x, y, p) * w >= FAR_R) continue;
          const key = `${x}/${y}`;
          if (!this.tiles.has(key)) this.tiles.set(key, this._entry(x, y));
        }
      }
    }
    if (foci.length && this.inflight < IN_FLIGHT) this._requestNext(want, foci[foci.length - 1], !dest, where, NEAR_R + w / 2);

    // one arrived tile per frame becomes a mesh (each GPU upload stays small)
    for (const t of this.tiles.values()) {
      if (t.ready) {
        this._build(t);
        break;
      }
    }

    // re-seat near tiles on the rendered terrain as it refines (no floating, no sinking)
    this.resampleT -= dt;
    if (this.resampleT <= 0) {
      this.resampleT = 0.1;
      const list = [];
      for (const t of this.tiles.values()) if (t.mesh && (t.rough || gap(t.x, t.y, here) * w < 1500)) list.push(t);
      if (list.length) this._reseat(list[(this._rr = ((this._rr ?? 0) + 1) % list.length)], performance.now() + BUDGET);
    }
  }

  /** Ground velocity in tiles/s, smoothed; a teleport or a warp hop isn't flight. */
  _track(here, dt) {
    const last = this._last;
    this._last = here;
    if (!last || dt <= 0) return;
    const vx = (here[0] - last[0]) / dt;
    const vy = (here[1] - last[1]) / dt;
    if (Math.hypot(vx, vy) > 2) {
      this._vel[0] = this._vel[1] = 0;
      return;
    }
    const k = Math.min(1, dt * 1.5);
    this._vel[0] += (vx - this._vel[0]) * k;
    this._vel[1] += (vy - this._vel[1]) * k;
  }

  _entry(x, y) {
    const [lat0, lon0] = tileCentre(x, y);
    const width = (40075016.686 * Math.cos(lat0 * DEG)) / 2 ** Z;
    return { key: `${x}/${y}`, x, y, lat0, lon0, radius: width * 0.75 + 300, level: null, pending: null, ready: null, mesh: null, retry: 0 };
  }

  /**
   * The next tiles to fetch: what's in view first, then nearest to where you'll be;
   * new tiles before filling in, and last, near tiles left far behind going back to
   * their skyline (a refetch from the HTTP cache — it frees their low-rise).
   */
  _requestNext(want, aim, viewing, where, shed) {
    if (viewing) {
      const cam = this.camera;
      this.frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      this._ground = this.earth.terrain.sampleCartographicElevation(where.lat * DEG, where.lon * DEG) ?? this._ground;
    }
    const list = [];
    for (const t of this.tiles.values()) {
      if (t.pending || t.ready || t.retry > this.clock.value) continue;
      const w = want(t);
      if (!w) continue;
      let s = gap(t.x, t.y, aim);
      if (t.level === 'near') {
        if (!t.mesh || t.d <= shed) continue;
        list.push([s + 4, t, 'far']);
        continue;
      }
      if (t.level === w) continue;
      if (t.level) s += 1.5;
      if (viewing && this._inView(t)) s -= 2;
      list.push([s, t, w]);
    }
    list.sort((a, b) => a[0] - b[0]);
    for (const [, t, w] of list) {
      if (this.inflight >= IN_FLIGHT) break;
      this._request(t, w);
    }
  }

  _inView(t) {
    if (!t.centre) {
      t.centre = new Vector3();
      this.frame.fromCartographic(t.lat0 * DEG, t.lon0 * DEG, this._ground, t.centre);
    }
    _sphere.center.copy(t.centre);
    _sphere.radius = t.radius;
    return this.frustum.intersectsSphere(_sphere);
  }

  _request(t, level) {
    t.pending = level;
    t.id = ++this._seq;
    this.inflight++;
    const at = (url) => url.replace('{z}', Z).replace('{x}', t.x).replace('{y}', t.y);
    this.worker.postMessage({ type: 'tile', id: t.id, url: at(this.template), dem: at(TERRARIUM), z: Z, x: t.x, y: t.y, lat0: t.lat0, lon0: t.lon0, level, exclude: this.exclude });
  }

  _received(m) {
    this.inflight = Math.max(0, this.inflight - 1);
    let t = null;
    for (const v of this.tiles.values()) if (v.id === m.id) t = v;
    if (!t || !t.pending) return; // dropped while it was in flight
    t.pending = null;
    if (!m.ok) {
      t.retry = this.clock.value + 20;
      console.warn('[buildings]', t.key, m.error);
    } else if (!m.count) t.level = m.level; // nothing at this level: no tall buildings out here, or none at all
    else t.ready = m;
  }

  _build(t) {
    const m = t.ready;
    t.ready = null;
    const N = m.count;
    const ground = m.ground;
    if (ground.some(Number.isNaN)) this._fallbackGround(t, m);
    const rows = Math.ceil(N / TEX_W);
    const data = new Float32Array(TEX_W * rows * 4);
    for (let b = 0; b < N; b++) {
      data[b * 4] = ground[b];
      data[b * 4 + 1] = m.xz[b * 2];
      data[b * 4 + 2] = m.xz[b * 2 + 1];
    }
    const tex = new DataTexture(data, TEX_W, rows, RGBAFormat, FloatType);
    tex.minFilter = tex.magFilter = NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.position, 3));
    g.setAttribute('normal', new BufferAttribute(m.normal, 3, true));
    g.setAttribute('color', new BufferAttribute(m.color, 3, true));
    g.setAttribute('aBld', new BufferAttribute(m.bld, 1));
    g.setIndex(new BufferAttribute(m.index, 1));
    for (const a of [...Object.values(g.attributes), g.index]) a.onUpload(dropArray);
    // the shader lifts each building onto its ground, so the bounds are set by hand
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of ground) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const [x0, z0, x1, z1, maxTop] = m.bounds;
    const y0 = lo - 6;
    const y1 = hi + maxTop;
    g.boundingSphere = new Sphere(new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);

    // replacing a tile's mesh (filling in, or back to the skyline): what was standing stays, only the rest dithers in
    const old = t.mesh;
    const mesh = new Mesh(g, this._material(tex, m.level === 'near' ? m.lodCount : N, old ? m.lodCount : 0));
    mesh.name = `buildings:${t.key}`;
    mesh.matrixAutoUpdate = false;
    // local frame at the tile centre: x east, y up, z south
    this.frame.fromCartographic(t.lat0 * DEG, t.lon0 * DEG, 0, _o);
    this.frame.enuAt(_o, _e, _n, _u);
    mesh.matrix.makeBasis(_e, _u, _s.copy(_n).negate()).setPosition(_o);
    mesh.matrixWorldNeedsUpdate = true;
    if (old) this._dispose(t);
    this.group.add(mesh);
    Object.assign(t, { mesh, tex, level: m.level, count: N, lodIndexCount: m.lodIndexCount, centroid: m.centroid, full: true, cursor: 0 });
    this.stats.tiles++;
    this.stats.buildings += N;
  }

  /** No elevation tile came with it: the loaded terrain under the tile centre will do until re-seating refines it. */
  _fallbackGround(t, m) {
    const h = this.earth.terrain.sampleCartographicElevation(t.lat0 * DEG, t.lon0 * DEG) ?? this._ground;
    for (let b = 0; b < m.count; b++) if (Number.isNaN(m.ground[b])) m.ground[b] = h;
    t.rough = true;
  }

  /** Beyond the detail ring a near tile's low-rise has thinned out anyway: stop sending it to the GPU. */
  _detail(t, full) {
    if (t.level !== 'near' || t.full === full) return;
    t.full = full;
    t.mesh.geometry.setDrawRange(0, full ? Infinity : t.lodIndexCount);
  }

  /** Finer terrain arrived: move the bases with it, a slice at a time (no floating, no sinking). */
  _reseat(t, until) {
    const terrain = this.earth.terrain;
    const { centroid, count } = t;
    const d = t.tex.image.data;
    const end = Math.min(count, t.cursor + RESEAT);
    let changed = false;
    let b = t.cursor;
    for (; b < end; b++) {
      if ((b & 63) === 0 && performance.now() > until) break;
      const h = terrain.sampleCartographicElevation(centroid[b * 2] * DEG, centroid[b * 2 + 1] * DEG);
      if (h != null && Math.abs(h - d[b * 4]) > 0.3) {
        d[b * 4] = h;
        changed = true;
      }
    }
    t.cursor = b >= count ? 0 : b;
    if (changed) t.tex.needsUpdate = true;
  }

  _dispose(t) {
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    t.mesh.material.dispose();
    t.tex.dispose();
    this.stats.tiles--;
    this.stats.buildings -= t.count;
    t.mesh = null;
    t.tex = null;
  }

  _drop(key, t) {
    if (t.mesh) this._dispose(t);
    this.tiles.delete(key);
  }

  /** lodCount: buildings [0, lodCount) are skyline (drawn out to FAR_R); fadeFrom: the first one that dithers in. */
  _material(tex, lodCount, fadeFrom) {
    // one program for every tile (same source); each tile brings its own data texture
    return new ShaderMaterial({
      name: 'buildings',
      vertexColors: true,
      uniforms: {
        ...this.atmoU,
        uBld: { value: tex },
        uBldW: { value: TEX_W },
        uClock: this.clock,
        uBorn: { value: this.clock.value },
        uFadeFrom: { value: fadeFrom },
        uLodCount: { value: lodCount },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
  }
}
