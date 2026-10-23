/**
 * Global configuration: URL flags, quality tiers and device detection.
 *
 * URL flags (handy while building / reviewing shots):
 *   ?debug            timeline HUD, scene jump buttons, FPS
 *   ?scene=3          start at a scene (1–5)
 *   ?t=20             seek into that scene (seconds, beats before t are auto-resolved)
 *   ?quality=low      force a tier: low | medium | high
 *   ?auto             auto-complete every interaction beat (hands-free review)
 *   ?mute             start muted
 *   ?nofx             disable post-processing (perf comparisons)
 */

const params = new URLSearchParams(window.location.search);

export const FLAGS = {
  debug: params.has('debug'),
  scene: clampInt(params.get('scene'), 1, 5, 1),
  seek: Math.max(0, parseFloat(params.get('t') || '0') || 0),
  quality: params.get('quality'),
  auto: params.has('auto'),
  mute: params.has('mute'),
  noFx: params.has('nofx'),
};

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Quality tiers. "medium" is the design target: a mid-range laptop (Apple M1 /
 * Iris Xe class) at ~60 fps. Every tier renders the same film; lower tiers only
 * trade resolution, MSAA, shadow detail, particle counts and the god-ray pass.
 */
export const QUALITY_TIERS = {
  low: {
    name: 'low',
    maxPixelRatio: 1,
    maxPixels: 1600 * 900,
    msaa: 0,
    shadowMapSize: 1024,
    bloomScale: 0.35,
    shafts: false,
    shaftSamples: 32,
    particleScale: 0.45,
    feedSize: 256,
    terrainDetail: 0.6,
  },
  medium: {
    name: 'medium',
    maxPixelRatio: 1.25,
    maxPixels: 2304 * 1296,
    msaa: 2,
    shadowMapSize: 2048,
    bloomScale: 0.5,
    shafts: true,
    shaftSamples: 40,
    particleScale: 0.75,
    feedSize: 384,
    terrainDetail: 0.85,
  },
  high: {
    name: 'high',
    maxPixelRatio: 1.75,
    maxPixels: 3200 * 1800,
    msaa: 4,
    shadowMapSize: 4096,
    bloomScale: 0.5,
    shafts: true,
    shaftSamples: 56,
    particleScale: 1,
    feedSize: 512,
    terrainDetail: 1,
  },
};

export function isSmallTouchDevice() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  return coarse && small;
}

/** Pick a tier from the GPU string. Conservative on integrated GPUs. */
export function detectQuality(renderer) {
  if (FLAGS.quality && QUALITY_TIERS[FLAGS.quality]) return QUALITY_TIERS[FLAGS.quality];
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    gpu = '';
  }
  const g = gpu.toLowerCase();
  if (isSmallTouchDevice()) return QUALITY_TIERS.low;
  if (/rtx|gtx 1[0-9]{3}|radeon rx|radeon pro|apple m[2-9]|apple m1 (pro|max|ultra)|arc a[0-9]/.test(g)) {
    return QUALITY_TIERS.high;
  }
  if (/apple m1|apple gpu|iris|radeon|geforce|nvidia/.test(g)) return QUALITY_TIERS.medium;
  if (/intel|uhd|hd graphics|mali|adreno|powervr|swiftshader|llvmpipe/.test(g)) return QUALITY_TIERS.low;
  return QUALITY_TIERS.medium;
}

/** Scene order and chapter names (also used by the pause menu). */
export const CHAPTERS = [
  { id: 1, numeral: 'I', title: 'The Call' },
  { id: 2, numeral: 'II', title: 'The Bridge' },
  { id: 3, numeral: 'III', title: 'Transit' },
  { id: 4, numeral: 'IV', title: 'Landing' },
  { id: 5, numeral: 'V', title: 'First Step' },
];
