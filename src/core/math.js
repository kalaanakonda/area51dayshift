/**
 * Small math toolkit shared by the camera, hands, workers and procedural builders.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a, b, v) => {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a, b, v) => {
  const t = invLerp(a, b, v);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Frame-rate independent exponential smoothing. */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Shortest signed angle difference a→b. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Deterministic PRNG so procedural sets look identical on every run. */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randRange = (rand, a, b) => a + (b - a) * rand();

function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smooth 1D value noise in [-1, 1]. Used for handheld drift and camera shake. */
export function vnoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), u) * 2 - 1;
}

export function fbm1(x, octaves = 3) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * freq + i * 17.13);
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

/** Yaw (rotation about +Y) that makes a camera at `from` face `to` (camera looks down -Z). */
export function yawTo(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** Pitch that makes a camera at `from` face `to`. */
export function pitchTo(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return Math.atan2(to.y - from.y, Math.hypot(dx, dz));
}
