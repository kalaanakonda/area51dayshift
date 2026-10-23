/**
 * Hand pose library (radians). Each finger: [mcp, pip, dip, spread].
 * Thumb: [flex, oppose, mcp, ip] — flex folds toward the palm, oppose swings
 * the thumb across it.
 *
 * These numbers ARE the fallback rig. A BlendKit hand GLB may instead ship
 * single-frame actions named `pose_<name>` (see manifest.fp_hands_*.clips);
 * when present those override the numbers below by name.
 */
export const POSES = {
  relaxed: {
    index: [0.32, 0.42, 0.24, 0.05],
    middle: [0.38, 0.48, 0.26, 0.0],
    ring: [0.44, 0.52, 0.28, -0.04],
    pinky: [0.52, 0.56, 0.3, -0.1],
    thumb: [0.18, 0.32, 0.16, 0.1],
  },
  flat: {
    index: [0.04, 0.05, 0.03, 0.08],
    middle: [0.04, 0.05, 0.03, 0.0],
    ring: [0.05, 0.05, 0.03, -0.07],
    pinky: [0.06, 0.06, 0.04, -0.15],
    thumb: [-0.05, 0.05, 0.02, 0.02],
  },
  fist: {
    index: [1.45, 1.62, 1.0, 0.0],
    middle: [1.5, 1.64, 1.0, 0.0],
    ring: [1.5, 1.64, 1.0, 0.0],
    pinky: [1.5, 1.6, 1.0, 0.0],
    thumb: [0.55, 1.0, 0.6, 0.55],
  },
  grip: {
    index: [1.02, 1.32, 0.82, 0.03],
    middle: [1.08, 1.36, 0.84, 0.0],
    ring: [1.12, 1.38, 0.86, -0.03],
    pinky: [1.18, 1.38, 0.86, -0.08],
    thumb: [0.4, 0.95, 0.42, 0.42],
  },
  rail: {
    index: [0.92, 1.18, 0.72, 0.03],
    middle: [0.96, 1.2, 0.74, 0.0],
    ring: [1.0, 1.22, 0.76, -0.03],
    pinky: [1.05, 1.22, 0.76, -0.08],
    thumb: [0.36, 0.85, 0.36, 0.34],
  },
  point: {
    index: [0.06, 0.08, 0.04, 0.02],
    middle: [1.32, 1.55, 0.95, 0.0],
    ring: [1.4, 1.58, 0.98, 0.0],
    pinky: [1.45, 1.58, 0.98, -0.04],
    thumb: [0.5, 0.88, 0.45, 0.4],
  },
  pinch: {
    index: [0.62, 0.68, 0.46, 0.04],
    middle: [0.8, 0.86, 0.52, 0.0],
    ring: [1.12, 1.24, 0.8, -0.03],
    pinky: [1.22, 1.3, 0.84, -0.08],
    thumb: [0.32, 0.72, 0.26, 0.3],
  },
  phone: {
    index: [0.42, 0.95, 0.5, 0.02],
    middle: [0.46, 1.0, 0.52, 0.0],
    ring: [0.52, 1.04, 0.54, -0.03],
    pinky: [0.6, 1.08, 0.56, -0.06],
    thumb: [-0.12, 0.28, 0.06, 0.05],
  },
  phoneTap: {
    index: [0.42, 0.95, 0.5, 0.02],
    middle: [0.46, 1.0, 0.52, 0.0],
    ring: [0.52, 1.04, 0.54, -0.03],
    pinky: [0.6, 1.08, 0.56, -0.06],
    thumb: [0.22, 0.62, 0.32, 0.42],
  },
  float: {
    index: [0.42, 0.55, 0.34, 0.1],
    middle: [0.48, 0.6, 0.36, 0.0],
    ring: [0.54, 0.62, 0.38, -0.08],
    pinky: [0.62, 0.66, 0.4, -0.16],
    thumb: [0.22, 0.36, 0.2, 0.16],
  },
  brace: {
    index: [1.15, 1.42, 0.9, 0.0],
    middle: [1.2, 1.46, 0.92, 0.0],
    ring: [1.24, 1.48, 0.92, 0.0],
    pinky: [1.28, 1.48, 0.92, -0.04],
    thumb: [0.5, 1.0, 0.52, 0.5],
  },
};

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/** Linear blend of two poses into `out`. */
export function blendPose(out, a, b, t) {
  for (const f of FINGERS) {
    const o = out[f] || (out[f] = [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) o[i] = a[f][i] + (b[f][i] - a[f][i]) * t;
  }
  return out;
}

export function clonePose(p) {
  const out = {};
  for (const f of FINGERS) out[f] = p[f].slice();
  return out;
}
