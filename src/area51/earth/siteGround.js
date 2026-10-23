import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CustomBlending,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OneFactor,
  Quaternion,
  ShaderMaterial,
  SrcColorFactor,
  TorusGeometry,
  Vector2,
  Vector3,
  Vector4,
  ZeroFactor,
} from 'three';
import { GLSL_ATMO } from './atmosphere.js';
import { lakebedTextures, macroNoiseTexture } from '../textures.js';
import { SLABS } from '../hangar/exterior.js';

/**
 * The ground around Hangar 9. The streamed terrain is unlit satellite imagery
 * (no shadows, a metre or so per texel), so up close it is a white smear the
 * building floats on. Over it, conforming to the same DEM, lies a multiply
 * overlay that adds:
 *
 *   • the sun's shadow — the hangar, the yard and everything else that casts
 *     into the sun's map now darkens the lakebed by the share of light the
 *     sun provides (same sun / sky split the terrain is relit with)
 *   • lakebed detail — cracked clay polygons, silt drifts, pebbles, grain, lit
 *     by the raking sun; fades out with distance so nothing tiles
 *   • site wear — compacted, gravelly ground around the slabs, darker stains
 *   • tyre tracks — ribbons along the service roads, ruts with tread
 *
 * Plus a windsock on the lakebed west of the apron. Hangar-local frame; the
 * group is counter-shifted when the hangar is re-seated so it stays on the ground.
 */
const R = 384; // half-extent, m
const STEP = 4; // grid spacing, m (≈ the DEM's texel at zoom 15)
const N = (2 * R) / STEP + 1;
const LIFT = 0.05;
const ROWS_FIRST = 24; // rows sampled per frame on the first pass
const ROWS_REFRESH = 2; // …and afterwards, as finer DEM tiles stream in

const MULTIPLY = {
  transparent: true,
  depthWrite: false,
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: ZeroFactor,
  blendDst: SrcColorFactor,
  blendEquationAlpha: AddEquation,
  blendSrcAlpha: ZeroFactor,
  blendDstAlpha: OneFactor, // keep the sky mask in alpha
};

// Service roads (hangar-local x, z). They start under the slabs and get clipped there.
const TRACKS = [
  { pts: [[5, -66], [8, -105], [3, -170], [-9, -245], [-16, -320], [-21, -390]], half: 1.35, k: 1.0 },
  { pts: [[-1.5, -66], [0, -104], [-6, -168], [-18, -242], [-27, -318], [-31, -390]], half: 1.3, k: 0.6 },
  { pts: [[-30, -66], [-46, -86], [-62, -130], [-80, -210], [-96, -300], [-108, -390]], half: 1.3, k: 0.75 },
  // patrol loop round the building and the yard
  { pts: [[33, -60], [47, -42], [52, -22], [53, 2], [50, 22], [38, 36], [12, 41], [-14, 41], [-38, 36], [-44, 18], [-45, -10], [-41, -40], [-33, -62]], half: 1.3, k: 0.7 },
  // to the yard's gate
  { pts: [[38, -30], [44, -16], [42, -9]], half: 1.3, k: 0.6 },
];

const SOCK = { x: -52, z: -55, mast: 6.2 };

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform mat4 uSunMatrix;
  uniform float uSunNormalBias;
  uniform vec2 uDepthBias;
  attribute vec2 track;
  varying vec3 vLocal;
  varying vec4 vSunCoord;
  varying vec2 vTrack;
  varying float vDist;
  void main() {
    vLocal = position;
    vTrack = track;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 up = normalize((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vSunCoord = uSunMatrix * vec4(wp.xyz + up * uSunNormalBias, 1.0);
    vec4 mv = viewMatrix * wp;
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
    #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
      // a hair toward the camera, so the overlay always wins against the
      // terrain mesh under it, however coarse that tile's LOD is
      vFragDepth = 1.0 + max(gl_Position.w * (1.0 - uDepthBias.x) - uDepthBias.y, 1e-3);
    #endif
  }
`;

const FRAG_COMMON = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec4 uSlabs[${SLABS.length}];
  uniform float uR;
  uniform sampler2D tMacro;
  varying vec3 vLocal;
  varying vec4 vSunCoord;
  varying vec2 vTrack;
  varying float vDist;
  void clipSlabs(vec2 p) {
    for (int i = 0; i < ${SLABS.length}; i++) {
      vec4 s = uSlabs[i];
      if (p.x > s.x && p.x < s.y && p.y > s.z && p.y < s.w) discard;
    }
  }
  float edgeFade(vec2 p) {
    return 1.0 - smoothstep(uR * 0.72, uR * 0.98, max(abs(p.x), abs(p.y)));
  }
`;

const GROUND_FRAG = /* glsl */ `
  ${FRAG_COMMON}
  ${GLSL_ATMO}
  uniform sampler2D tDetail;
  uniform sampler2D tSite;
  uniform sampler2DShadow uSunMap;
  uniform vec4 uSunShadow; // x strength, y bias, z PCF radius (texels), w 1 / map size
  uniform vec3 uSunLocal;
  uniform float uDetail;

  float sunShadow() {
    if (uSunShadow.x <= 0.0) return 1.0;
    vec3 c = vSunCoord.xyz / vSunCoord.w;
    c.z += uSunShadow.y;
    if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
    float r = uSunShadow.z * uSunShadow.w;
    float phi = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
    float s = 0.0;
    for (int i = 0; i < 5; i++) {
      float rr = sqrt((float(i) + 0.5) / 5.0);
      float th = float(i) * 2.3999632 + phi;
      s += texture(uSunMap, vec3(c.xy + vec2(cos(th), sin(th)) * rr * r, c.z));
    }
    return mix(1.0, s * 0.2, uSunShadow.x);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vLocal.xz;
    clipSlabs(p);

    // the terrain's own light split (atmosphere.js, a51GroundLight)
    vec3 N = normalize(uA51Cam);
    float ndl = dot(N, uA51Sun);
    vec3 tSun = a51SunTransmittance(0.0, ndl);
    vec3 sunL = tSun * max(ndl, 0.0) * smoothstep(-0.035, 0.06, ndl);
    vec3 skyL = vec3(0.16, 0.2, 0.28) * smoothstep(-0.16, 0.3, ndl) * (0.35 + 0.65 * tSun.g);
    float sh = sunShadow();

    float edge = edgeFade(p);
    vec3 site = texture2D(tSite, vec2(p.x / (2.0 * uR) + 0.5, 0.5 - p.y / (2.0 * uR))).rgb;
    vec3 mac = texture2D(tMacro, p / 240.0).rgb;
    vec3 mac2 = texture2D(tMacro, p / 37.0 + 0.31).rgb;
    float wear = clamp(site.r * (0.55 + 0.9 * mac2.g), 0.0, 1.0);
    float gravel = clamp(site.g * (0.45 + 1.1 * mac2.r) + smoothstep(0.6, 0.85, mac.g) * 0.3, 0.0, 1.0);

    float a1 = (1.0 - smoothstep(90.0, 300.0, vDist)) * edge * uDetail;
    float a2 = (1.0 - smoothstep(240.0, 900.0, vDist)) * edge * uDetail;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    vec4 d1 = texture2D(tDetail, p * 0.25);
    vec4 d2 = texture2D(tDetail, rot * p / 11.3 + 0.47);
    float crust = (1.0 - wear * 0.8) * (0.55 + 0.45 * smoothstep(0.25, 0.6, mac.g));
    float alb = mix(1.0, d1.r * 1.25, a1 * crust) * mix(1.0, d2.r * 1.25, a2 * crust * 0.85);
    alb *= 1.0 + (d1.a - 0.5) * 2.0 * a1 * (0.2 + 0.8 * gravel);
    // patchy crust tone, compacted / gravelly ground round the slabs, stains
    alb *= mix(1.0, 0.93 + 0.14 * mac.r, edge);
    alb *= 1.0 - (wear * 0.13 + gravel * 0.07) * edge;
    alb *= 1.0 - site.b * 0.4 * smoothstep(0.3, 0.65, mac2.b) * edge;

    // raking-sun relief of the crust: curled rims, crack walls, grain
    vec2 sl = (d1.gb - 0.5) * 1.2 * a1 * crust + (transpose(rot) * (d2.gb - 0.5)) * 1.2 * a2 * crust * 0.6;
    vec3 n = normalize(vec3(-sl.x, 1.0, -sl.y));
    float relief = clamp(dot(n, uSunLocal) / max(uSunLocal.y, 0.08), 0.2, 1.9);

    vec3 f = alb * (skyL + sunL * sh * relief) / (skyL + sunL + 1e-5);
    // the satellite tile reads snow-white up close: a little dust and warmth near the site
    f *= mix(vec3(1.0), vec3(0.975, 0.95, 0.91), edge);
    gl_FragColor = vec4(f, 1.0);
  }
`;

const TRACK_FRAG = /* glsl */ `
  ${FRAG_COMMON}
  uniform vec4 uTrack; // x rut offset, y strength, z length

  float rut(float d) { return 1.0 - smoothstep(0.1, 0.19, d); }
  float berm(float d) { return smoothstep(0.12, 0.2, d) * (1.0 - smoothstep(0.2, 0.34, d)); }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vLocal.xz;
    clipSlabs(p);
    float u = vTrack.x;
    float v = vTrack.y;
    // the driver wanders a little, the ruts come and go with the crust
    float wob = (texture2D(tMacro, vec2(v * 0.0031, uTrack.x * 0.37)).g - 0.5) * 0.55;
    float d1 = abs(u - wob + uTrack.x);
    float d2 = abs(u - wob - uTrack.x);
    float tread = step(0.5, fract(v * 6.5 + min(d1, d2) * 2.0));
    float fresh = smoothstep(0.28, 0.62, texture2D(tMacro, vec2(v / 170.0, 0.71 + uTrack.x)).r);
    float ends = smoothstep(0.0, 12.0, v) * (1.0 - smoothstep(uTrack.z - 30.0, uTrack.z, v));
    float k = uTrack.y * (0.45 + 0.55 * fresh) * ends * edgeFade(p) * (1.0 - smoothstep(500.0, 1800.0, vDist));
    float near = 1.0 - smoothstep(30.0, 160.0, vDist);
    float dark = (rut(d1) + rut(d2)) * (0.13 + 0.05 * tread * near) - (berm(d1) + berm(d2)) * 0.045 * near;
    // between and outside the ruts the crust is crushed a little too
    dark += (1.0 - smoothstep(uTrack.x + 0.25, uTrack.x + 0.9, abs(u - wob))) * 0.035;
    gl_FragColor = vec4(vec3(1.0 - k * dark), 1.0);
  }
`;

export class SiteGround {
  constructor({ hangar, earth, frame, atmoU, sun }) {
    this.hangar = hangar;
    this.earth = earth;
    this.frame = frame;
    this.sun = sun;
    this.group = new Group();
    this.group.name = 'site-ground';
    this.group.visible = false;
    hangar.group.add(this.group);
    this.y0 = null;
    this.heights = new Float32Array(N * N);
    this.known = new Uint8Array(N * N);
    this.row = 0;
    this.passes = 0;
    this.dirty = false;
    this._inv = new Matrix4();
    this._q = new Quaternion();

    const slabs = SLABS.map(([x0, x1, z0, z1]) => new Vector4(x0, x1, z0, z1));
    const shared = {
      uSlabs: { value: slabs },
      uR: { value: R },
      tMacro: { value: macroNoiseTexture() },
      uSunMatrix: { value: sun.shadow.matrix },
      uSunNormalBias: { value: sun.shadow.normalBias },
      // a coarse parent tile can sit decimetres above the DEM while the fine one streams in
      uDepthBias: { value: new Vector2(0.004, 0.25) },
    };
    this.uniforms = {
      ...atmoU,
      ...shared,
      tDetail: { value: lakebedTextures().detail },
      tSite: { value: siteTexture() },
      uSunMap: { value: null },
      uSunShadow: { value: new Vector4() },
      uSunLocal: { value: new Vector3(0, 1, 0) },
      uDetail: { value: 1 },
    };
    this.ground = new Mesh(gridGeometry(), new ShaderMaterial({ name: 'site-ground', uniforms: this.uniforms, vertexShader: VERT, fragmentShader: GROUND_FRAG, ...MULTIPLY }));
    this.ground.renderOrder = -2;
    this.ground.name = 'site-ground';
    this.group.add(this.ground);

    this.tracks = TRACKS.map((t, i) => {
      const curve = new CatmullRomCurve3(t.pts.map(([x, z]) => new Vector3(x, 0, z)), false, 'centripetal');
      const len = curve.getLength();
      const mat = new ShaderMaterial({
        name: 'site-track',
        uniforms: { ...shared, uTrack: { value: new Vector4(0.8, t.k, len, 0) } },
        vertexShader: VERT,
        fragmentShader: TRACK_FRAG,
        ...MULTIPLY,
      });
      mat.uniforms.uTrack.value.x = 0.78 + (i % 2) * 0.04;
      const mesh = new Mesh(ribbonGeometry(curve, len, t.half), mat);
      mesh.renderOrder = -1;
      mesh.name = `site-track-${i}`;
      this.group.add(mesh);
      return mesh;
    });

    this.sock = windsock(hangar);
    this.group.add(this.sock.root);
  }

  /** Terrain height (group frame) under hangar-local (x, z), or null while it isn't streamed. */
  _height(x, z) {
    const hg = this.hangar.group;
    const p = _p.set(x, 0, z).applyMatrix4(hg.matrixWorld);
    const c = this.frame.cartographic(p, _c);
    const h = this.earth.groundHeight(p, c);
    if (h == null) return null;
    this.frame.fromCartographic(c.lat, c.lon, h, p).applyMatrix4(this._inv);
    return p.y - this.group.position.y;
  }

  /** Bilinear height from the sampled grid (group frame). */
  heightAt(x, z) {
    const gx = Math.min(N - 1.001, Math.max(0, (x + R) / STEP));
    const gz = Math.min(N - 1.001, Math.max(0, (z + R) / STEP));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const H = this.heights;
    const a = H[j * N + i] * (1 - fx) + H[j * N + i + 1] * fx;
    const b = H[(j + 1) * N + i] * (1 - fx) + H[(j + 1) * N + i + 1] * fx;
    return a * (1 - fz) + b * fz;
  }

  _sampleRows(count) {
    const hg = this.hangar.group;
    this._inv.copy(hg.matrixWorld).invert();
    const pos = this.ground.geometry.attributes.position;
    for (let r = 0; r < count; r++) {
      const j = this.row;
      const z = -R + j * STEP;
      let changed = false;
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const y = this._height(-R + i * STEP, z);
        if (y == null) continue;
        if (!this.known[k] || Math.abs(this.heights[k] - y) > 0.01) {
          this.heights[k] = y;
          this.known[k] = 1;
          pos.setY(k, y + LIFT);
          changed = true;
        }
      }
      if (changed) {
        pos.addUpdateRange(j * N * 3, N * 3);
        pos.needsUpdate = true;
        this.dirty = true;
      }
      this.row = (j + 1) % N;
      if (this.row === 0) this._passDone();
    }
  }

  _passDone() {
    if (!this.known.includes(1)) return; // nothing streamed yet: not a pass
    this.passes++;
    if (!this.dirty) return;
    this.dirty = false;
    // holes (never streamed) take their neighbours' height so nothing hangs in the air
    for (let k = 0; k < N * N; k++) {
      if (this.known[k]) continue;
      const near = this.known[k - 1] ? k - 1 : this.known[k + 1] ? k + 1 : this.known[k - N] ? k - N : this.known[k + N] ? k + N : -1;
      if (near >= 0) this.heights[k] = this.heights[near];
    }
    this.ground.geometry.computeBoundingSphere();
    for (const t of this.tracks) {
      const pos = t.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setY(i, this.heightAt(pos.getX(i), pos.getZ(i)) + LIFT + 0.012);
      pos.needsUpdate = true;
      t.geometry.computeBoundingSphere();
    }
    this.sock.root.position.set(SOCK.x, this.heightAt(SOCK.x, SOCK.z), SOCK.z);
    this.group.visible = true;
  }

  update(dt, t, { sunWorld, near = true } = {}) {
    const hg = this.hangar.group;
    if (this.y0 === null) this.y0 = hg.position.y;
    // the hangar gets re-seated as the DEM refines: stay put on the ground
    this.group.position.y = this.y0 - hg.position.y;
    this.group.updateMatrixWorld();
    if (near) this._sampleRows(this.passes === 0 ? ROWS_FIRST : ROWS_REFRESH);

    const s = this.sun.shadow;
    const u = this.uniforms;
    const live = this.sun.castShadow && s.map;
    u.uSunMap.value = live ? s.map.depthTexture : null;
    u.uSunShadow.value.set(live ? s.intensity : 0, s.bias, s.radius, 1 / s.mapSize.x);
    u.uSunNormalBias.value = s.normalBias;
    if (sunWorld) u.uSunLocal.value.copy(sunWorld).applyQuaternion(hg.getWorldQuaternion(this._q).invert());
    this.sock.update(dt, t);
  }
}

const _p = new Vector3();
const _c = {};

/** N × N grid in the XZ plane (y filled in by sampling); quads well inside the slabs are left out. */
function gridGeometry() {
  const pos = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 3;
      pos[k] = -R + i * STEP;
      pos[k + 2] = -R + j * STEP;
    }
  }
  const index = [];
  const covered = (x, z) => SLABS.some(([x0, x1, z0, z1]) => x > x0 + STEP && x < x1 - STEP && z > z0 + STEP && z < z1 - STEP);
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      if (covered(-R + (i + 0.5) * STEP, -R + (j + 0.5) * STEP)) continue;
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('track', new BufferAttribute(new Float32Array(N * N * 2), 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** A flat strip along `curve`: track.x = metres across (−half…half), track.y = metres along. */
function ribbonGeometry(curve, len, half) {
  const n = Math.max(2, Math.ceil(len / 1.5));
  const pos = new Float32Array((n + 1) * 2 * 3);
  const trk = new Float32Array((n + 1) * 2 * 2);
  const p = new Vector3();
  const t = new Vector3();
  for (let s = 0; s <= n; s++) {
    const u = s / n;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    const nx = -t.z;
    const nz = t.x;
    const l = Math.hypot(nx, nz) || 1;
    for (let e = 0; e < 2; e++) {
      const side = e ? half : -half;
      const k = s * 2 + e;
      pos[k * 3] = p.x + (nx / l) * side;
      pos[k * 3 + 2] = p.z + (nz / l) * side;
      trk[k * 2] = side;
      trk[k * 2 + 1] = u * len;
    }
  }
  const index = [];
  for (let s = 0; s < n; s++) {
    const a = s * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('track', new BufferAttribute(trk, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/**
 * Wear map over the whole overlay (canvas, x right / z down, metres):
 * r = compaction by traffic, g = gravel / disturbed ground, b = stains.
 */
function siteTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.setTransform(S / (2 * R), 0, 0, S / (2 * R), S / 2, S / 2);
  g.globalCompositeOperation = 'lighter';
  const blob = (x, z, r, col) => {
    const gr = g.createRadialGradient(x, z, 0, x, z, r);
    gr.addColorStop(0, col);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, z - r, r * 2, r * 2);
  };
  // disturbed, gravelled ground round the building, apron and yard
  g.filter = 'blur(7px)';
  for (const [x0, x1, z0, z1] of SLABS) {
    g.fillStyle = 'rgb(70,150,0)';
    g.fillRect(x0 - 12, z0 - 12, x1 - x0 + 24, z1 - z0 + 24);
  }
  g.fillStyle = 'rgb(60,70,0)';
  g.fillRect(-70, -95, 140, 150);
  // traffic corridors along the service roads
  g.filter = 'blur(3px)';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const t of TRACKS) {
    g.strokeStyle = `rgb(${Math.round(120 * t.k)},${Math.round(90 * t.k)},0)`;
    g.lineWidth = 7;
    g.beginPath();
    t.pts.forEach(([x, z], i) => (i ? g.lineTo(x, z) : g.moveTo(x, z)));
    g.stroke();
  }
  // turnaround by the yard, stains where things park and drip
  g.filter = 'blur(2px)';
  blob(56, -4, 22, 'rgba(150,60,0,1)');
  for (const [x, z, r, k] of [[46, -6, 3.5, 1], [44, 6, 2.5, 0.8], [52, -16, 2, 0.7], [-38, -64, 3, 0.9], [37, -68, 2.5, 0.7], [-8, -76, 2, 0.6], [9, -79, 3, 0.8]]) {
    blob(x, z, r * 2.2, `rgba(0,0,${Math.round(255 * k)},1)`);
  }
  g.filter = 'none';
  const t = new CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/** Windsock on a 6 m mast: five banded segments that fill, droop and flutter with a gusting breeze. */
function windsock(hangar) {
  const root = new Group();
  root.name = 'windsock';
  const ext = (o) => {
    const m = new MeshStandardMaterial(o);
    hangar.exterior.push(m);
    return m;
  };
  const galv = ext({ name: 'sock_mast', color: 0xb9bdbf, roughness: 0.38, metalness: 0.85 });
  const concrete = ext({ name: 'sock_base', color: 0xb4ad9f, roughness: 0.92 });
  const orange = ext({ name: 'sock_orange', color: 0xe0561d, roughness: 0.82, side: DoubleSide });
  const white = ext({ name: 'sock_white', color: 0xe6e3dc, roughness: 0.82, side: DoubleSide });
  const add = (parent, geo, mat, x, y, z) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  add(root, new CylinderGeometry(0.45, 0.5, 0.6, 16), concrete, 0, -0.18, 0);
  add(root, new CylinderGeometry(0.045, 0.06, SOCK.mast, 12), galv, 0, SOCK.mast / 2, 0);
  add(root, new CylinderGeometry(0.07, 0.07, 0.12, 12), galv, 0, SOCK.mast - 0.35, 0);
  const pivot = new Group();
  pivot.position.set(0, SOCK.mast - 0.3, 0);
  root.add(pivot);
  const ring = add(pivot, new TorusGeometry(0.42, 0.018, 6, 28), galv, 0.12, 0, 0);
  ring.rotation.y = Math.PI / 2;
  add(pivot, new CylinderGeometry(0.02, 0.02, 0.14, 8).rotateZ(Math.PI / 2), galv, 0.05, 0, 0);
  const segs = [];
  let parent = pivot;
  const L = 0.74;
  for (let i = 0; i < 5; i++) {
    const r0 = 0.42 - i * 0.05;
    const r1 = r0 - 0.05;
    const geo = new CylinderGeometry(r1, r0, L, 22, 2, true).rotateZ(-Math.PI / 2).translate(L / 2, 0, 0);
    const seg = new Group();
    seg.position.x = i === 0 ? 0.12 : L;
    parent.add(seg);
    add(seg, geo, i % 2 ? white : orange, 0, 0, 0);
    segs.push(seg);
    parent = seg;
  }
  let dir = 0.6;
  return {
    root,
    update(dt, t) {
      const gust = 0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.077 + 1.3);
      const speed = 3.2 + gust * 4.5 + Math.sin(t * 1.7) * 0.4; // m/s
      const fill = Math.min(1, speed / 7.7); // a 15 kt sock flies straight out
      dir += (0.6 + Math.sin(t * 0.05) * 0.35 + Math.sin(t * 0.31) * 0.08 - dir) * Math.min(1, dt * 0.8);
      pivot.rotation.y = dir;
      segs.forEach((s, i) => {
        const k = (i + 1) / 5;
        s.rotation.z = -(1 - fill) * (0.55 + k * 0.25) + Math.sin(t * (5.5 + i * 0.9) + i * 1.1) * 0.05 * (0.4 + fill) * k;
        s.rotation.y = Math.sin(t * (3.9 + i * 0.7) + i * 2.1) * 0.07 * k;
      });
    },
  };
}
