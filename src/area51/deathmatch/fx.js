import {
  AdditiveBlending,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NormalBlending,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  BoxGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise } from '../../core/noise.js';
import { mulberry32 } from '../../core/math.js';

/**
 * Deathmatch effects, all in the arena's local frame (+Y up, metres):
 *
 *   glow    additive particles — fire, sparks, flashes, shock rings, glows, embers
 *   smoke   alpha particles — black wreck smoke, grey trails, dust
 *   beams   camera-facing ribbons — lasers, arcs, plasma and tracer streaks,
 *           teleport columns, missile exhaust
 *   debris  tumbling hull shards that fall, bounce once and smoulder
 *   missiles small instanced airframes (positions come from the match)
 *
 * Particles are stateless on the GPU: each one is written once into a ring
 * buffer (start, velocity, drag, buoyancy, sizes, colour) and the vertex shader
 * evaluates its flight in closed form — drag pulls it toward the wind, so
 * smoke drifts and sparks keep their momentum.
 */

export const GLOW = { FIRE: 0, SPARK: 1, FLASH: 2, RING: 3, GLOW: 4, EMBER: 5 };
export const SMOKE = { SMOKE: 0, DUST: 1 };
export const PATTERN = { SOLID: 0, BEADS: 1, HELIX: 2, ARC: 3, BOLT: 4, COLUMN: 5, FLAME: 6, TRACER: 7 };

const PARTICLE_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float uTime;
  uniform vec3 uWind;
  uniform float uPx;
  attribute vec4 iA; // start xyz, birth time
  attribute vec4 iB; // velocity xyz, life
  attribute vec4 iC; // size0, size1, drag, rise (m/s², + up)
  attribute vec4 iD; // rgb, kind + seed
  attribute vec2 iE; // opacity, spin
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vU;
  varying float vKind;
  varying float vSeed;
  varying float vHaze;
  void main() {
    float age = uTime - iA.w;
    float life = iB.w;
    vKind = floor(iD.w);
    vSeed = fract(iD.w);
    if (age < 0.0 || age >= life) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    float u = age / life;
    vU = u;
    float k = iC.z;
    vec3 v0 = iB.xyz;
    vec3 p;
    vec3 vel;
    if (k > 0.001) {
      float e = exp(-k * age);
      p = iA.xyz + uWind * age + (v0 - uWind) * (1.0 - e) / k;
      vel = uWind + (v0 - uWind) * e;
    } else {
      p = iA.xyz + v0 * age;
      vel = v0;
    }
    p.y += 0.5 * iC.w * age * age;
    vel.y += iC.w * age;
    float size = mix(iC.x, iC.y, 1.0 - (1.0 - u) * (1.0 - u));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // far particles stay at least ~1.5 px across (dimmed to keep their energy)
    float minSize = 1.5 * uPx * max(-mv.z, 0.01);
    float dim = 1.0;
    if (size < minSize) {
      dim = size / minSize;
      size = minSize;
    }
    vec2 c = position.xy;
    vUv = uv;
#ifdef ADDITIVE
    // flashes, rings and glows that fill the view fade back, so a blast at
    // close range reads as light, not a white-out
    if (vKind >= 2.0 && vKind <= 4.0) dim *= 1.0 - 0.85 * smoothstep(0.3, 1.2, size / max(-mv.z, 0.01));
    if (vKind == 1.0) {
      // spark: a streak along its projected velocity
      vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
      vec2 d = vv.xy;
      float l = length(d);
      vec2 dir = l > 1e-5 ? d / l : vec2(1.0, 0.0);
      float stretch = 1.0 + clamp(length(vv) * 0.05, 0.0, 9.0);
      mv.xy += dir * c.y * size * stretch + vec2(-dir.y, dir.x) * c.x * size;
    } else
#endif
    {
      float a = vSeed * 6.2832 + age * iE.y;
      float cs = cos(a);
      float sn = sin(a);
      mv.xy += mat2(cs, sn, -sn, cs) * c * size;
    }
    vCol = vec4(iD.rgb, iE.x * dim);
    vHaze = exp(-length(mv.xyz) / 15000.0);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uPuff;
  uniform float uTime;
  uniform vec3 uSun;
  uniform vec3 uAmb;
  uniform vec3 uHaze;
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vU;
  varying float vKind;
  varying float vSeed;
  varying float vHaze;
  vec4 puff() {
    float c = floor(vSeed * 4.0);
    vec2 cell = vec2(mod(c, 2.0), floor(c * 0.5));
    return texture2D(uPuff, (clamp(vUv, 0.01, 0.99) + cell) * 0.5);
  }
  void main() {
    #include <logdepthbuf_fragment>
    vec2 q = vUv - 0.5;
    float r = length(q) * 2.0;
    float u = vU;
#ifdef ADDITIVE
    vec3 col;
    if (vKind == 0.0) {
      // fire: white-hot core cooling through orange to a dull red as it dies
      vec4 pf = puff();
      vec3 hot = vec3(5.0, 3.9, 2.6);
      vec3 mid = vec3(3.4, 1.15, 0.24);
      vec3 cool = vec3(0.55, 0.1, 0.025);
      vec3 ramp = u < 0.22 ? mix(hot, mid, u / 0.22) : mix(mid, cool, (u - 0.22) / 0.78);
      float a = pf.a * (1.0 - u) * smoothstep(0.0, 0.05, u + 0.01);
      col = ramp * vCol.rgb * a * (0.7 + 0.6 * pf.g);
    } else if (vKind == 1.0) {
      float s = exp(-q.x * q.x * 40.0) * exp(-q.y * q.y * 7.0);
      col = vCol.rgb * s * (1.0 - u);
    } else if (vKind == 2.0) {
      float s = exp(-r * r * 5.0);
      col = vCol.rgb * s * (1.0 - u) * (1.0 - u);
    } else if (vKind == 3.0) {
      float s = exp(-pow((r - 0.82) * 10.0, 2.0)) + exp(-r * r * 3.0) * 0.12;
      col = vCol.rgb * s * (1.0 - u) * (1.0 - u);
    } else if (vKind == 4.0) {
      float s = exp(-r * r * 6.0);
      col = vCol.rgb * s * (1.0 - smoothstep(0.55, 1.0, u));
    } else {
      float s = exp(-r * r * 16.0) * (0.55 + 0.45 * sin(uTime * 31.0 + vSeed * 57.0));
      col = vCol.rgb * s * (1.0 - u);
    }
    gl_FragColor = vec4(col * vCol.a * vHaze, 1.0);
#else
    vec4 pf = puff();
    float a = pf.a * smoothstep(0.0, 0.07, u) * pow(1.0 - u, 1.4);
    vec3 lit = vCol.rgb * (uAmb + uSun * (0.35 + 0.65 * pf.g));
    lit = mix(uHaze, lit, vHaze);
    gl_FragColor = vec4(lit, a * vCol.a);
#endif
  }
`;

class Particles {
  constructor({ capacity, additive, puff, shared }) {
    this.cap = capacity;
    this.head = 0;
    this.pending = 0;
    this.flushStart = 0;
    const quad = new PlaneGeometry(1, 1);
    const g = new InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    const attr = (name, size) => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.A = attr('iA', 4);
    this.B = attr('iB', 4);
    this.C = attr('iC', 4);
    this.D = attr('iD', 4);
    this.E = attr('iE', 2);
    // everything starts dead (life 0)
    g.instanceCount = capacity;
    this.material = new ShaderMaterial({
      uniforms: { ...shared, uPuff: { value: puff } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      defines: additive ? { ADDITIVE: '' } : {},
      transparent: true,
      depthWrite: false,
      side: DoubleSide, // billboards: the camera-facing basis can come out mirrored
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 30 : 20;
    this.mesh.name = additive ? 'dm:glow' : 'dm:smoke';
  }

  /**
   * One particle. p, v: arena-local; life (s); s0 → s1 size (m); drag (1/s,
   * toward the wind); rise (m/s², + up, gravity is negative); rgb; kind; t0.
   */
  emit(px, py, pz, vx, vy, vz, life, s0, s1, drag, rise, r, g, b, kind, t0, opacity = 1, spin = 0.6) {
    const i = this.head;
    this.head = (i + 1) % this.cap;
    const a = this.A.array;
    const bb = this.B.array;
    const c = this.C.array;
    const d = this.D.array;
    const e = this.E.array;
    const k = i * 4;
    a[k] = px;
    a[k + 1] = py;
    a[k + 2] = pz;
    a[k + 3] = t0;
    bb[k] = vx;
    bb[k + 1] = vy;
    bb[k + 2] = vz;
    bb[k + 3] = life;
    c[k] = s0;
    c[k + 1] = s1;
    c[k + 2] = drag;
    c[k + 3] = rise;
    d[k] = r;
    d[k + 1] = g;
    d[k + 2] = b;
    d[k + 3] = kind + Math.random() * 0.999;
    e[i * 2] = opacity;
    e[i * 2 + 1] = (Math.random() - 0.5) * spin * 2;
    if (this.pending === 0) this.flushStart = i;
    this.pending++;
  }

  flush() {
    const n = Math.min(this.pending, this.cap);
    if (!n) return;
    const s = this.flushStart;
    for (const at of [this.A, this.B, this.C, this.D, this.E]) {
      const w = at.itemSize;
      if (s + n <= this.cap) at.addUpdateRange(s * w, n * w);
      else {
        at.addUpdateRange(s * w, (this.cap - s) * w);
        at.addUpdateRange(0, (s + n - this.cap) * w);
      }
      at.needsUpdate = true;
    }
    this.pending = 0;
  }

  /** Kill everything (match restart). */
  clear() {
    this.B.array.fill(0);
    this.B.clearUpdateRanges();
    this.B.needsUpdate = true;
    this.pending = 0;
  }
}

// Beams are capsules drawn in screen space: the quad is built around both
// projected ends (clipped to the near plane) so a beam seen end-on is a round
// glow, not a slab. The fragment finds its distance to the projected segment
// and maps the screen position back to the beam (perspective-correct).
const BEAM_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float uTime;
  uniform float uPx;
  attribute vec4 iS; // start xyz, width
  attribute vec4 iE; // end xyz, pattern
  attribute vec4 iC; // rgb, intensity
  attribute vec4 iM; // birth, life, seed, unused
  varying vec3 vQ;    // screen position × w (screen-linear once divided)
  varying vec4 vS;    // both ends on screen (aspect-corrected NDC)
  varying vec2 vR;    // their radii on screen
  varying vec4 vWT;   // their clip w, and the span of the beam left after clipping
  varying vec4 vInfo; // length, pattern, fade, seed
  varying vec4 vCol;
  void main() {
    vec3 a0 = (modelViewMatrix * vec4(iS.xyz, 1.0)).xyz;
    vec3 b0 = (modelViewMatrix * vec4(iE.xyz, 1.0)).xyz;
    float n = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0) * 1.01;
    if (a0.z > -n && b0.z > -n) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    float t0 = 0.0;
    float t1 = 1.0;
    vec3 a = a0;
    vec3 b = b0;
    if (a0.z > -n) {
      t0 = (a0.z + n) / (a0.z - b0.z);
      a = mix(a0, b0, t0);
    }
    if (b0.z > -n) {
      t1 = (a0.z + n) / (a0.z - b0.z);
      b = mix(a0, b0, t1);
    }
    vec4 ca = projectionMatrix * vec4(a, 1.0);
    vec4 cb = projectionMatrix * vec4(b, 1.0);
    float sy = projectionMatrix[1][1];
    vec2 asp = vec2(sy / projectionMatrix[0][0], 1.0);
    vec2 sa = ca.xy / ca.w * asp;
    vec2 sb = cb.xy / cb.w * asp;
    float hw = 0.5 * iS.w;
    // never thinner than ~1.6 px: dim instead, to keep the energy
    float rmin = 0.8 * uPx * sy;
    float ra = hw * sy / ca.w;
    float rb = hw * sy / cb.w;
    float ka = ra < rmin ? ra / rmin : 1.0;
    float kb = rb < rmin ? rb / rmin : 1.0;
    ra = max(ra, rmin);
    rb = max(rb, rmin);
    vec2 d2 = sb - sa;
    float L = length(d2);
    vec2 dir = L > 1e-7 ? d2 / L : vec2(1.0, 0.0);
    vec2 perp = vec2(-dir.y, dir.x);
    // big enough for both end discs, however foreshortened
    float Ra = max(ra, rb - L);
    float Rb = max(rb, ra - L);
    bool atB = position.y > 0.0;
    vec2 s = atB ? sb + (perp * position.x * 2.0 + dir) * Rb : sa + (perp * position.x * 2.0 - dir) * Ra;
    vec4 c = atB ? cb : ca;
    gl_Position = vec4(s / asp * c.w, c.z, c.w);
    vQ = vec3(s * c.w, c.w);
    vS = vec4(sa, sb);
    vR = vec2(ra, rb);
    vWT = vec4(ca.w, cb.w, t0, t1);
    float age = uTime - iM.x;
    vInfo = vec4(length(iE.xyz - iS.xyz), iE.w, 1.0 - clamp(age / max(iM.y, 1e-4), 0.0, 1.0), iM.z);
    vCol = vec4(iC.rgb, iC.a * (atB ? kb : ka));
    #include <logdepthbuf_vertex>
  }
`;

const BEAM_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uTime;
  varying vec3 vQ;
  varying vec4 vS;
  varying vec2 vR;
  varying vec4 vWT;
  varying vec4 vInfo;
  varying vec4 vCol;
  // screen parameter → beam parameter (w is linear along the beam, screen position is not)
  float unproject(float h) {
    float u = h * vWT.x / max(h * vWT.x + (1.0 - h) * vWT.y, 1e-6);
    return mix(vWT.z, vWT.w, u);
  }
  void main() {
    #include <logdepthbuf_fragment>
    vec2 q = vQ.xy / vQ.z;
    vec2 A = vS.xy;
    vec2 ab = vS.zw - A;
    float L2 = dot(ab, ab);
    float L = sqrt(L2);
    float hr = L2 > 1e-14 ? dot(q - A, ab) / L2 : 0.0;
    float h = clamp(hr, 0.0, 1.0);
    vec2 off = q - (A + ab * h);
    float r = mix(vR.x, vR.y, h);
    float d = length(off);
    float x = d / r;
    if (x >= 1.0) discard;
    x *= dot(off, vec2(-ab.y, ab.x)) < 0.0 ? -1.0 : 1.0;
    // how far along the beam this pixel reaches: seen end-on, all the way
    float reach = sqrt(max(r * r - d * d, 0.0)) / max(L, 1e-7);
    float along = unproject(h);
    float head = unproject(clamp(hr + reach, 0.0, 1.0));
    float len = vInfo.x;
    float pat = vInfo.y;
    float seed = vInfo.w;
    float m = along * len;
    float t = uTime;
    float core;
    float glow;
    float ends = 1.0;
    // (smoothstep edges always ascending: reversed ones are undefined and come out 0 on some GPUs)
    if (pat < 0.5) {
      core = exp(-x * x * 26.0);
      glow = exp(-x * x * 3.2);
    } else if (pat < 1.5) {
      // pulse train: bright beads racing down the beam
      float k = pow(0.5 + 0.5 * sin(m * 0.21 - t * 95.0 + seed * 20.0), 5.0);
      core = exp(-x * x * 18.0) * (0.25 + 1.8 * k);
      glow = exp(-x * x * 2.6) * (0.35 + 0.9 * k);
    } else if (pat < 2.5) {
      // helix: two strands winding round a thin core
      float ph = m * 0.32 - t * 42.0 + seed * 9.0;
      float s = sin(ph) * 0.52;
      core = exp(-pow((x - s) * 7.5, 2.0)) * (0.6 + 0.4 * cos(ph)) + exp(-pow((x + s) * 7.5, 2.0)) * (0.6 - 0.4 * cos(ph)) + exp(-x * x * 50.0) * 0.5;
      glow = exp(-x * x * 2.2) * 0.75;
    } else if (pat < 3.5) {
      // lightning: a thin flickering core in a wide halo
      float fl = 0.55 + 0.45 * sin(t * 140.0 + seed * 31.0 + m * 0.4);
      core = exp(-x * x * 60.0) * fl * 1.7;
      glow = exp(-x * x * 4.0) * 0.8 * fl;
    } else if (pat < 4.5) {
      // plasma bolt: brightest at the head
      float hd = head * head;
      core = exp(-x * x * 9.0) * (0.15 + hd * 2.2);
      glow = exp(-x * x * 1.5) * (0.1 + hd * 1.0);
    } else if (pat < 5.5) {
      // teleport column: soft light with streaks flowing down it
      float nz = 0.65 + 0.35 * sin(m * 0.045 + t * 16.0 + x * 2.0 + seed * 7.0);
      core = exp(-x * x * 7.0) * nz;
      glow = exp(-x * x * 1.3) * 0.55;
      ends = smoothstep(0.0, 0.25, along) * (1.0 - smoothstep(0.94, 1.0, along));
    } else if (pat < 6.5) {
      // exhaust flame: fat at the nozzle (along = 1), tapering to the tail
      float tp = head;
      float fl = 0.8 + 0.2 * sin(t * 90.0 + seed * 13.0);
      core = exp(-x * x * (6.0 / max(tp, 0.08))) * tp * 1.6 * fl;
      glow = exp(-x * x * 1.8) * tp * 0.7;
    } else {
      // tracer: thin, hot head
      float hd = smoothstep(0.0, 1.0, head);
      core = exp(-x * x * 20.0) * (0.2 + hd * 1.6);
      glow = exp(-x * x * 2.4) * (0.1 + hd * 0.5);
    }
    float edge = 1.0 - smoothstep(0.7, 1.0, abs(x));
    vec3 col = vCol.rgb * (core * 2.6 + glow * 0.75) * vCol.a * vInfo.z * ends * edge;
    gl_FragColor = vec4(col, 1.0);
  }
`;

class Beams {
  constructor({ capacity = 6000, shared }) {
    this.cap = capacity;
    this.n = 0;
    const quad = new PlaneGeometry(1, 1);
    const g = new InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    const attr = (name) => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.S = attr('iS');
    this.Eb = attr('iE');
    this.Cb = attr('iC');
    this.M = attr('iM');
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new ShaderMaterial({
      uniforms: { uTime: shared.uTime, uPx: shared.uPx },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide, // the ribbon's side vector is cross(axis, view), which winds clockwise
      blending: AdditiveBlending,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.mesh.name = 'dm:beams';
  }

  begin() {
    this.n = 0;
  }

  push(ax, ay, az, bx, by, bz, width, pattern, r, g, b, intensity, t0, life, seed) {
    if (this.n >= this.cap) return;
    const k = this.n * 4;
    const S = this.S.array;
    const E = this.Eb.array;
    const C = this.Cb.array;
    const M = this.M.array;
    S[k] = ax;
    S[k + 1] = ay;
    S[k + 2] = az;
    S[k + 3] = width;
    E[k] = bx;
    E[k + 1] = by;
    E[k + 2] = bz;
    E[k + 3] = pattern;
    C[k] = r;
    C[k + 1] = g;
    C[k + 2] = b;
    C[k + 3] = intensity;
    M[k] = t0;
    M[k + 1] = life;
    M[k + 2] = seed;
    M[k + 3] = 0;
    this.n++;
  }

  end() {
    const n = this.n;
    this.geometry.instanceCount = n;
    if (!n) return;
    for (const at of [this.S, this.Eb, this.Cb, this.M]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * 4);
      at.needsUpdate = true;
    }
  }
}

/** Jagged hull shard (non-indexed, flat facets). */
function shardGeometry() {
  const rand = mulberry32(5);
  const g = new IcosahedronGeometry(1, 0); // (already non-indexed: flat facets)
  const p = g.getAttribute('position');
  // squash into a plate and jitter each corner (shared corners move together)
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(key)) seen.set(key, [0.6 + rand() * 0.8, 0.6 + rand() * 0.8]);
    const [a, b] = seen.get(key);
    p.setXYZ(i, p.getX(i) * a, p.getY(i) * 0.28 * b, p.getZ(i) * (0.5 + a * 0.5));
  }
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

class Debris {
  constructor(capacity = 700) {
    this.cap = capacity;
    this.material = new MeshStandardMaterial({ color: 0xffffff, metalness: 0.75, roughness: 0.42 });
    this.mesh = new InstancedMesh(shardGeometry(), this.material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'dm:debris';
    this.mesh.castShadow = false;
    const z = new Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, z);
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 4); // quaternion
    this.spin = new Float32Array(capacity * 4); // axis xyz, rate
    this.size = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.rest = new Float32Array(capacity);
    this.smoke = new Float32Array(capacity); // smoulder seconds left
    this.emitT = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.head = 0;
    this.count = 0;
  }

  spawn(p, v, color, size, smoulder = 0) {
    const i = this.head;
    this.head = (i + 1) % this.cap;
    const k = i * 3;
    this.pos[k] = p.x;
    this.pos[k + 1] = p.y;
    this.pos[k + 2] = p.z;
    this.vel[k] = v.x;
    this.vel[k + 1] = v.y;
    this.vel[k + 2] = v.z;
    const ax = Math.random() - 0.5;
    const ay = Math.random() - 0.5;
    const az = Math.random() - 0.5;
    const al = Math.hypot(ax, ay, az) || 1;
    this.spin[i * 4] = ax / al;
    this.spin[i * 4 + 1] = ay / al;
    this.spin[i * 4 + 2] = az / al;
    this.spin[i * 4 + 3] = 3 + Math.random() * 12;
    _q.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.rot[i * 4] = _q.x;
    this.rot[i * 4 + 1] = _q.y;
    this.rot[i * 4 + 2] = _q.z;
    this.rot[i * 4 + 3] = _q.w;
    this.size[k] = size * (0.6 + Math.random() * 0.8);
    this.size[k + 1] = size * (0.6 + Math.random() * 0.8);
    this.size[k + 2] = size * (0.6 + Math.random() * 0.8);
    this.life[i] = 14 + Math.random() * 6;
    this.rest[i] = 0;
    this.smoke[i] = smoulder;
    this.emitT[i] = Math.random() * 0.05;
    this.alive[i] = 1;
    this.mesh.instanceColor.setXYZ(i, color.r, color.g, color.b);
    this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt, arena, fx, t) {
    const m = this.mesh;
    let dirty = false;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      dirty = true;
      const k = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alive[i] = 0;
        m.setMatrixAt(i, _zero);
        continue;
      }
      let x = this.pos[k];
      let y = this.pos[k + 1];
      let z = this.pos[k + 2];
      const ground = arena.groundY(x, z);
      if (this.rest[i] < 1) {
        const drag = Math.exp(-0.18 * dt);
        this.vel[k] *= drag;
        this.vel[k + 2] *= drag;
        this.vel[k + 1] = this.vel[k + 1] * drag - 9.81 * dt;
        x += this.vel[k] * dt;
        y += this.vel[k + 1] * dt;
        z += this.vel[k + 2] * dt;
        const floor = ground + this.size[k + 1] * 0.25;
        if (y < floor) {
          y = floor;
          if (this.vel[k + 1] < -6 && this.rest[i] === 0) {
            // one bounce, then it lies there
            this.vel[k + 1] *= -0.25;
            this.vel[k] *= 0.4;
            this.vel[k + 2] *= 0.4;
            this.rest[i] = 0.5;
          } else {
            this.rest[i] = 1;
            this.spin[i * 4 + 3] = 0;
            if (this.life[i] > 7) this.life[i] = 5 + Math.random() * 3;
          }
        }
        this.pos[k] = x;
        this.pos[k + 1] = y;
        this.pos[k + 2] = z;
        const rate = this.spin[i * 4 + 3];
        if (rate > 0) {
          _a.set(this.spin[i * 4], this.spin[i * 4 + 1], this.spin[i * 4 + 2]);
          _q2.setFromAxisAngle(_a, rate * dt);
          _q.set(this.rot[i * 4], this.rot[i * 4 + 1], this.rot[i * 4 + 2], this.rot[i * 4 + 3]).premultiply(_q2);
          this.rot[i * 4] = _q.x;
          this.rot[i * 4 + 1] = _q.y;
          this.rot[i * 4 + 2] = _q.z;
          this.rot[i * 4 + 3] = _q.w;
        }
      }
      // smouldering shards trail smoke (and a few embers) while they fall
      if (this.smoke[i] > 0) {
        this.smoke[i] -= dt;
        // puffs by distance as much as by time, back-dated along this frame's
        // path, so a fast shard draws a line rather than a string of beads
        const falling = this.rest[i] < 1;
        const v = falling ? Math.hypot(this.vel[k], this.vel[k + 1], this.vel[k + 2]) : 0;
        this.emitT[i] -= dt * (1 + v / 16);
        const s = this.size[k];
        for (let e = 0; e < 3 && this.emitT[i] <= 0; e++) {
          this.emitT[i] += falling ? 0.06 : 0.35;
          const back = falling ? Math.random() * dt : 0;
          const px = x - this.vel[k] * back;
          const py = y - this.vel[k + 1] * back;
          const pz = z - this.vel[k + 2] * back;
          fx.smoke.emit(px, py, pz, this.vel[k] * 0.15, this.vel[k + 1] * 0.15 + 1, this.vel[k + 2] * 0.15, 2.2 + Math.random(), s * 0.9, s * 4, 0.9, 1.4, 0.07, 0.065, 0.06, SMOKE.SMOKE, t - back, 0.75);
          if (Math.random() < 0.25) fx.glow.emit(px, py, pz, 0, 0, 0, 0.35, s * 0.9, s * 0.5, 0, 0, 1.6, 0.6, 0.18, GLOW.EMBER, t - back);
        }
        if (this.emitT[i] < 0) this.emitT[i] = 0;
      }
      // fade out by shrinking during the last second
      const fade = Math.min(1, this.life[i]);
      _q.set(this.rot[i * 4], this.rot[i * 4 + 1], this.rot[i * 4 + 2], this.rot[i * 4 + 3]);
      _s.set(this.size[k] * fade, this.size[k + 1] * fade, this.size[k + 2] * fade);
      _p.set(x, y, z);
      _m.compose(_p, _q, _s);
      m.setMatrixAt(i, _m);
    }
    if (dirty) m.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    for (let i = 0; i < this.cap; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Small seeker airframe, nose along −Z. */
function missileGeometry() {
  const parts = [];
  const body = new CylinderGeometry(0.17, 0.17, 2.0, 10, 1);
  body.rotateX(Math.PI / 2);
  parts.push(body);
  const nose = new ConeGeometry(0.17, 0.55, 10, 1);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, 0, -1.27);
  parts.push(nose);
  for (let k = 0; k < 4; k++) {
    const fin = new BoxGeometry(0.03, 0.42, 0.4);
    fin.translate(0, 0.27, 0.78);
    fin.rotateZ((k * Math.PI) / 2 + Math.PI / 4);
    parts.push(fin);
  }
  const g = mergeGeometries(parts.map((p) => {
    const q = p.index ? p.toNonIndexed() : p;
    q.deleteAttribute('uv');
    return q;
  }));
  g.computeVertexNormals();
  return g;
}

class MissileMeshes {
  constructor(capacity = 240) {
    this.cap = capacity;
    this.material = new MeshStandardMaterial({ color: 0xd9dcdf, metalness: 0.55, roughness: 0.38 });
    this.mesh = new InstancedMesh(missileGeometry(), this.material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'dm:missiles';
  }

  begin() {
    this.mesh.count = 0;
  }

  push(pos, quat) {
    if (this.mesh.count >= this.cap) return;
    _m.compose(pos, quat, _one);
    this.mesh.setMatrixAt(this.mesh.count++, _m);
  }

  end() {
    if (this.mesh.count) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** 2×2 atlas of soft, lumpy puffs: alpha = density, green = top-lit shading. */
function puffAtlas() {
  const C = 128;
  const S = C * 2;
  const N = createNoise(91);
  const data = new Uint8Array(S * S * 4);
  for (let c = 0; c < 4; c++) {
    const ox = (c % 2) * C;
    const oy = Math.floor(c / 2) * C;
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = ((x + 0.5) / C) * 2 - 1;
        const v = ((y + 0.5) / C) * 2 - 1;
        const r = Math.hypot(u, v);
        const n = N.fbm2(u * 1.9 + c * 7.1, v * 1.9 + c * 3.3, 4);
        const edge = 0.74 + 0.2 * n;
        const fall = Math.max(0, Math.min(1, (edge - r) / 0.42));
        const body = fall * fall * (3 - 2 * fall);
        const fine = 0.7 + 0.3 * N.fbm2(u * 5.3 - c, v * 5.3 + c * 2, 3);
        const dens = Math.max(0, Math.min(1, body * fine * 1.15));
        const shade = Math.max(0, Math.min(1, 0.55 + v * 0.32 - u * 0.12 + n * 0.25 - (1 - body) * 0.1));
        const i = ((oy + y) * S + ox + x) * 4;
        data[i] = 255;
        data[i + 1] = Math.round(shade * 255);
        data[i + 2] = 255;
        data[i + 3] = Math.round(dens * 255);
      }
    }
  }
  const t = new DataTexture(data, S, S);
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

const _q = new Quaternion();
const _q2 = new Quaternion();
const _a = new Vector3();
const _p = new Vector3();
const _s = new Vector3();
const _m = new Matrix4();
const _one = new Vector3(1, 1, 1);
const _zero = new Matrix4().makeScale(0, 0, 0);
const _v = new Vector3();
const _w = new Vector3();
const _u2 = new Vector3();
const _bolt = new Float32Array(3 * 33); // lightning scratch: 32 segments
const _fork = new Float32Array(3 * 9);

/**
 * Fx — the effect systems plus the composite effects the match asks for
 * (explosions, hit sparks, teleport arrivals…). Timed beams and arcs live
 * here; streaks for projectiles are pushed fresh every frame.
 */
export class Fx {
  constructor({ quality = 'medium' } = {}) {
    this.group = new Group();
    this.group.name = 'dm:fx';
    this.time = 0;
    this.scale = quality === 'low' ? 0.5 : quality === 'high' ? 1 : 0.8;
    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: new Vector3() },
      uPx: { value: 0.001 },
      uSun: { value: new Vector3(1.2, 1.15, 1.05) },
      uAmb: { value: new Vector3(0.28, 0.32, 0.4) },
      uHaze: { value: new Vector3(0.62, 0.7, 0.84) },
    };
    const puff = puffAtlas();
    this.glow = new Particles({ capacity: 16384, additive: true, puff, shared: this.uniforms });
    this.smoke = new Particles({ capacity: 16384, additive: false, puff, shared: this.uniforms });
    this.beams = new Beams({ shared: this.uniforms });
    this.debris = new Debris(700);
    this.missiles = new MissileMeshes(240);
    this.group.add(this.smoke.mesh, this.debris.mesh, this.missiles.mesh, this.glow.mesh, this.beams.mesh);
    this.timed = []; // { a, b, w, pat, r, g, b, i, t0, life, seed }
    this.arcs = []; // { pts: [Vector3...], t0, life, seed }
    this.columns = []; // lingering wreck smoke columns { p, t, s, every, acc }
  }

  /** Per-frame environment: camera (for pixel sizes), wind, sun/sky colours. */
  setView({ fovDeg, heightPx, wind, sunColor, skyColor }) {
    this.uniforms.uPx.value = (2 * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, heightPx);
    if (wind) this.uniforms.uWind.value.copy(wind);
    if (sunColor) this.uniforms.uSun.value.set(sunColor.r, sunColor.g, sunColor.b).multiplyScalar(1.25);
    if (skyColor) this.uniforms.uAmb.value.set(skyColor.r, skyColor.g, skyColor.b).multiplyScalar(1.6).addScalar(0.04);
  }

  /** A beam that lasts `life` seconds. */
  beam(a, b, width, pattern, color, intensity = 1, life = 0.12) {
    this.timed.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, w: width, pat: pattern, r: color[0], g: color[1], b: color[2], i: intensity, t0: this.time, life, seed: Math.random() });
  }

  /** A beam for this frame only (projectile streaks, exhaust). */
  streak(a, b, width, pattern, color, intensity = 1) {
    this.beams.push(a.x, a.y, a.z, b.x, b.y, b.z, width, pattern, color[0], color[1], color[2], intensity, this.time, 1e6, Math.random());
  }

  /** Lightning through a chain of points, re-jagged every frame while it lives. */
  arc(points, life = 0.22, w0 = 1) {
    this.arcs.push({ pts: points.map((p) => p.clone()), t0: this.time, life, w0, seed: (Math.random() * 2 ** 31) | 0 });
  }

  /**
   * Start the frame: advance time, emit the smoke columns. The match then
   * adds this frame's beams, streaks and particles, and commit() lays down
   * the timed beams and arcs (this frame's included) and uploads everything.
   */
  update(dt) {
    this.time += dt;
    const t = this.time;
    this.uniforms.uTime.value = t;
    this.beams.begin();
    this.missiles.begin();
    // wreck smoke columns
    this.columns = this.columns.filter((c) => (c.t -= dt) > 0);
    for (const c of this.columns) {
      c.acc += dt;
      const k = Math.min(1, c.t / 6);
      while (c.acc > c.every) {
        c.acc -= c.every;
        const j = 3 * c.s;
        this.smoke.emit(c.p.x + (Math.random() - 0.5) * j, c.p.y + Math.random() * 2, c.p.z + (Math.random() - 0.5) * j, 0, 3 + Math.random() * 2, 0, 7 + Math.random() * 4, 5 * c.s, 26 * c.s, 0.45, 1.3, 0.05, 0.048, 0.045, SMOKE.SMOKE, t, 0.85 * k);
        if (Math.random() < 0.5 * k) this.glow.emit(c.p.x + (Math.random() - 0.5) * j, c.p.y + 1, c.p.z + (Math.random() - 0.5) * j, 0, 4, 0, 0.7 + Math.random() * 0.5, 3 * c.s, 6 * c.s, 1.5, 2.5, 1, 0.8, 0.7, GLOW.FIRE, t, 0.9 * k);
      }
    }
  }

  commit() {
    const t = this.time;
    const B = this.beams;
    this.timed = this.timed.filter((e) => t - e.t0 < e.life);
    for (const e of this.timed) B.push(e.ax, e.ay, e.az, e.bx, e.by, e.bz, e.w, e.pat, e.r, e.g, e.b, e.i, e.t0, e.life, e.seed);
    this.arcs = this.arcs.filter((a) => t - a.t0 < a.life);
    for (const a of this.arcs) this._arcSegments(a);
    B.end();
    this.missiles.end();
    this.glow.flush();
    this.smoke.flush();
  }

  _arcSegments(a) {
    const t = this.time;
    const age = t - a.t0;
    const fade = 1 - age / a.life;
    // the bolt's shape holds for its life; the fine crackle re-rolls every 30 ms
    const flick = Math.floor(age / 0.03);
    for (let s = 0; s + 1 < a.pts.length; s++) {
      const p0 = a.pts[s];
      const p1 = a.pts[s + 1];
      const len = p0.distanceTo(p1);
      if (len < 0.5) continue;
      const shape = mulberry32(a.seed + s * 977);
      const crackle = mulberry32(a.seed + s * 977 + flick * 7919);
      const depth = Math.max(3, Math.min(5, Math.ceil(Math.log2(len / 5))));
      const n = this._bolt(p0, p1, depth, 0.36, shape, crackle, 2, _bolt);
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        const B = _bolt;
        // (the first hop swells from the shooter's own scale)
        const wk = s === 0 && a.w0 < 1 ? a.w0 + (1 - a.w0) * (i / n) : 1;
        this.beams.push(B[k], B[k + 1], B[k + 2], B[k + 3], B[k + 4], B[k + 5], 2.6 * wk, PATTERN.ARC, 0.6, 0.8, 1.7, 1.5 * fade, t, 1e6, a.seed * 1e-9 + i * 0.37);
      }
      // forks off the main channel, held with the shape
      const forks = 1 + Math.floor(shape() * Math.min(4, len / 40));
      for (let f = 0; f < forks; f++) {
        const at = Math.floor(n * (0.15 + shape() * 0.7)) * 3;
        _v.set(_bolt[at], _bolt[at + 1], _bolt[at + 2]);
        _a.subVectors(p1, p0).normalize();
        perp(_a, _w);
        _u2.crossVectors(_a, _w);
        const th = shape() * Math.PI * 2;
        const bl = len * (0.12 + shape() * 0.22);
        _p.copy(_v)
          .addScaledVector(_a, bl * 0.7)
          .addScaledVector(_w, Math.cos(th) * bl * 0.7)
          .addScaledVector(_u2, Math.sin(th) * bl * 0.7);
        const m = this._bolt(_v, _p, 3, 0.45, shape, crackle, 1, _fork);
        for (let i = 0; i < m; i++) {
          const k = i * 3;
          // thinning towards the tip
          const tip = 1 - i / m;
          this.beams.push(_fork[k], _fork[k + 1], _fork[k + 2], _fork[k + 3], _fork[k + 4], _fork[k + 5], 1.0 + 0.8 * tip, PATTERN.ARC, 0.55, 0.75, 1.6, (0.4 + 0.6 * tip) * fade, t, 1e6, f * 0.61 + i * 0.29);
        }
      }
    }
  }

  /**
   * Midpoint displacement from p0 to p1 into `out` (flat xyz): 2^depth
   * segments, each level's kink proportional to its length, so the bolt is
   * jagged at every scale. The first `held` levels draw on `shape`, the rest
   * on `crackle`. Returns the segment count.
   */
  _bolt(p0, p1, depth, rough, shape, crackle, held, out) {
    const N = 1 << depth;
    const len = p0.distanceTo(p1);
    _a.subVectors(p1, p0).divideScalar(len || 1);
    perp(_a, _w);
    _u2.crossVectors(_a, _w);
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      out[i * 3] = p0.x + (p1.x - p0.x) * f;
      out[i * 3 + 1] = p0.y + (p1.y - p0.y) * f;
      out[i * 3 + 2] = p0.z + (p1.z - p0.z) * f;
    }
    for (let L = 0, step = N; L < depth; L++, step >>= 1) {
      const R = L < held ? shape : crackle;
      const half = step >> 1;
      const amp = rough * len * (step / N);
      for (let i = half; i < N; i += step) {
        const a = (i - half) * 3;
        const b = (i + half) * 3;
        const th = R() * Math.PI * 2;
        const r = (R() - 0.5) * amp;
        const k = i * 3;
        out[k] = (out[a] + out[b]) * 0.5 + (_w.x * Math.cos(th) + _u2.x * Math.sin(th)) * r;
        out[k + 1] = (out[a + 1] + out[b + 1]) * 0.5 + (_w.y * Math.cos(th) + _u2.y * Math.sin(th)) * r;
        out[k + 2] = (out[a + 2] + out[b + 2]) * 0.5 + (_w.z * Math.cos(th) + _u2.z * Math.sin(th)) * r;
      }
    }
    return N;
  }

  // ---------------------------------------------------------- composites

  /** Fireball, sparks, smoke, shock ring. scale 1 ≈ a missile; 3 ≈ a wreck hitting the ground. */
  explosion(p, scale = 1, { smoke = true, ring = true, sparks = true, color = null } = {}) {
    const t = this.time;
    const s = scale;
    const q = this.scale;
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.16 + 0.05 * s, 6 * s, 26 * s, 0, 0, 3, 2.6, 2.2, GLOW.FLASH, t);
    const nf = Math.round((10 + 6 * s) * q);
    for (let i = 0; i < nf; i++) {
      rndDir(_v).multiplyScalar((8 + Math.random() * 22) * Math.sqrt(s));
      const sz = (2.5 + Math.random() * 3) * s;
      this.glow.emit(p.x + _v.x * 0.1, p.y + _v.y * 0.1, p.z + _v.z * 0.1, _v.x, _v.y, _v.z, 0.5 + Math.random() * 0.6 + s * 0.15, sz, sz * 3.2, 2.8, 5, 1, 1, 1, GLOW.FIRE, t);
    }
    if (sparks) {
      const ns = Math.round((16 + 10 * s) * q);
      const c = color || [3.2, 2.0, 0.9];
      for (let i = 0; i < ns; i++) {
        rndDir(_v).multiplyScalar(40 + Math.random() * 110 * Math.sqrt(s));
        this.glow.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, 0.5 + Math.random() * 1.1, 0.35 + Math.random() * 0.3, 0.2, 1.1, -9.8, c[0], c[1], c[2], GLOW.SPARK, t);
      }
    }
    if (ring) this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.38, 3 * s, 34 * s, 0, 0, 1.6, 1.5, 1.35, GLOW.RING, t, 0.8);
    if (smoke) {
      const nm = Math.round((6 + 5 * s) * q);
      for (let i = 0; i < nm; i++) {
        rndDir(_v).multiplyScalar(4 + Math.random() * 10 * Math.sqrt(s));
        const sz = (4 + Math.random() * 3) * s;
        this.smoke.emit(p.x + _v.x * 0.4, p.y + _v.y * 0.4, p.z + _v.z * 0.4, _v.x, _v.y + 2, _v.z, 3 + Math.random() * 3 + s, sz, sz * 3.6, 1.1, 1.6, 0.075, 0.07, 0.065, SMOKE.SMOKE, t + 0.05, 0.9);
      }
    }
  }

  /** Small impact: sparks + flash in the weapon's colour. */
  hit(p, dir, color, n = 8, size = 1) {
    const t = this.time;
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.1, 2.2 * size, 5 * size, 0, 0, color[0] * 0.8, color[1] * 0.8, color[2] * 0.8, GLOW.FLASH, t);
    const m = Math.round(n * this.scale);
    for (let i = 0; i < m; i++) {
      rndDir(_v);
      if (dir) _v.addScaledVector(dir, -0.8).normalize();
      _v.multiplyScalar(25 + Math.random() * 70);
      this.glow.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, 0.25 + Math.random() * 0.45, 0.25, 0.15, 1.6, -9.8, 3, 2.1, 1.1, GLOW.SPARK, t);
    }
  }

  /** Round hits the ground: dust and a spark. */
  groundHit(p, size = 1) {
    const t = this.time;
    this.smoke.emit(p.x, p.y + 0.5, p.z, 0, 3, 0, 1.6 + Math.random(), 1.5 * size, 7 * size, 1.4, 0.4, 0.42, 0.37, 0.3, SMOKE.DUST, t, 0.55);
    this.glow.emit(p.x, p.y + 0.3, p.z, 0, 0, 0, 0.08, 1.4 * size, 3 * size, 0, 0, 2.5, 1.8, 1.0, GLOW.FLASH, t);
  }

  /** A wreck's crash site keeps burning and smoking for a while. */
  smokeColumn(p, seconds = 18, size = 1) {
    this.columns.push({ p: p.clone(), t: seconds, s: size, every: 0.09 / this.scale, acc: 0 });
  }

  /** Teleport arrival: flash, light column from the sky, ring, a burst of motes. */
  arrival(p, color, scale = 1) {
    const t = this.time;
    const [r, g, b] = color;
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.35, 8 * scale, 46 * scale, 0, 0, r * 2.2, g * 2.2, b * 2.2, GLOW.FLASH, t);
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.55, 4 * scale, 60 * scale, 0, 0, r, g, b, GLOW.RING, t, 0.9);
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 1.1, 14 * scale, 22 * scale, 0, 0, r * 0.6, g * 0.6, b * 0.6, GLOW.GLOW, t, 0.8);
    _v.set(p.x, p.y + 900, p.z);
    this.beam(_v, p, 7 * scale, PATTERN.COLUMN, [r * 1.2, g * 1.2, b * 1.2], 1.3, 0.75);
    const n = Math.round(26 * this.scale);
    for (let i = 0; i < n; i++) {
      rndDir(_v).multiplyScalar(10 + Math.random() * 30);
      this.glow.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, 0.6 + Math.random() * 0.7, 0.5, 0.2, 2.2, 1.5, r * 1.4, g * 1.4, b * 1.4, GLOW.SPARK, t);
    }
  }

  clear() {
    this.glow.clear();
    this.smoke.clear();
    this.debris.clear();
    this.timed.length = 0;
    this.arcs.length = 0;
    this.columns.length = 0;
  }
}

/** Random unit vector. */
export function rndDir(out) {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(a), u, s * Math.sin(a));
}

/** Unit vector perpendicular to unit vector v. */
function perp(v, out) {
  if (Math.abs(v.y) < 0.9) out.set(-v.z, 0, v.x);
  else out.set(0, v.z, -v.y);
  return out.normalize();
}
