import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { canvasTexture, tileableField } from '../procedural/textures.js';
import { createNoise } from '../core/noise.js';
import { mulberry32 } from '../core/math.js';

/**
 * Area 51 texture sets — procedural stand-ins until BlendKit / Poly Haven
 * scans are dropped into public/assets/textures (same slot names).
 * Everything is generated once and cached.
 */

const cache = new Map();
const memo = (k, fn) => {
  if (!cache.has(k)) cache.set(k, fn());
  return cache.get(k);
};

/**
 * Height field (w × h) → tangent-space normal map, OpenGL convention (green = +v).
 * Rows run bottom-up like a DataTexture's, or top-down (`topDown`) when the
 * heights were read back from a canvas whose CanvasTexture three flips on
 * upload, so bumps land under the colour they were painted with.
 */
export function normalFromHeight(hgt, w, h, strength, { topDown = false, wrapY = true } = {}) {
  const d = new Uint8Array(w * h * 4);
  const at = (x, y) => hgt[(wrapY ? (y + h) % h : Math.min(h - 1, Math.max(0, y))) * w + ((x + w) % w)];
  const sv = topDown ? -1 : 1; // down the canvas is −v
  for (let y = 0; y < h; y++) {
    const row = topDown ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const du = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dv = (at(x, y + 1) - at(x, y - 1)) * strength * sv;
      const len = Math.hypot(du, dv, 1);
      const i = (row * w + x) * 4;
      d[i] = ((-du / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((-dv / len) * 0.5 + 0.5) * 255;
      d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  const t = new DataTexture(d, w, h, RGBAFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  if (wrapY) t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function dataTexture(data, size, srgb) {
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Hangar floor: power-trowelled concrete under a worn grey epoxy coat.
 * One tile = 8 m. Saw-cut joints every 4 m, tyre scuffs, hydraulic-fluid
 * stains (darker, glossier), aggregate speckle where the coat has worn thin.
 */
export function floorTextures() {
  return memo('floor', () => {
    const S = 1024;
    const N = createNoise(51);
    const rand = mulberry32(5);
    const col = new Uint8Array(S * S * 4);
    const rough = new Uint8Array(S * S * 4);
    const height = new Float32Array(S * S);
    const mottle = tileableField(256, 4, 5, 9);
    const wear = tileableField(256, 9, 4, 13);
    const stains = [];
    for (let i = 0; i < 9; i++) stains.push({ x: rand(), y: rand(), r: 0.02 + rand() * 0.06, k: 0.4 + rand() * 0.6 });
    const scuffs = [];
    // mostly along the tow lanes (the hangar's long axis), a few across; faint, so the 8 m repeat doesn't read
    for (let i = 0; i < 9; i++) {
      const a = (rand() < 0.7 ? Math.PI / 2 : 0) + (rand() - 0.5) * 0.45;
      scuffs.push({ x: rand(), y: rand(), a, l: 0.06 + rand() * 0.2, w: 0.003 + rand() * 0.005, k: 0.1 + rand() * 0.14 });
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const v = y / S;
        const m = mottle[((y >> 2) % 256) * 256 + ((x >> 2) % 256)];
        const w = wear[((y >> 2) % 256) * 256 + ((x >> 2) % 256)];
        const speck = N.noise2(x * 0.9, y * 0.9) * 0.5 + 0.5;
        // Epoxy base (warm grey-green), mottled.
        let r = 0.42 + (m - 0.5) * 0.08;
        let g = 0.44 + (m - 0.5) * 0.08;
        let b = 0.43 + (m - 0.5) * 0.07;
        let ro = 0.3 + (m - 0.5) * 0.12;
        // Worn patches expose concrete aggregate.
        const worn = Math.max(0, (w - 0.62) * 4);
        if (worn > 0) {
          const agg = speck > 0.72 ? 0.12 : speck < 0.25 ? -0.08 : 0;
          r = r * (1 - worn) + (0.5 + agg) * worn;
          g = g * (1 - worn) + (0.49 + agg) * worn;
          b = b * (1 - worn) + (0.46 + agg) * worn;
          ro = ro * (1 - worn) + 0.72 * worn;
        }
        // Stains: darker, slightly glossier (fluid) with soft halos.
        for (const s of stains) {
          let dx = Math.abs(u - s.x);
          let dy = Math.abs(v - s.y);
          dx = Math.min(dx, 1 - dx);
          dy = Math.min(dy, 1 - dy);
          const d = Math.sqrt(dx * dx + dy * dy) / s.r;
          if (d < 1.4) {
            const edge = N.noise2(x * 0.03 + s.x * 40, y * 0.03) * 0.25;
            const f = Math.max(0, 1 - Math.max(0, d + edge - 0.2) / 1.0) * s.k;
            r *= 1 - f * 0.22;
            g *= 1 - f * 0.22;
            b *= 1 - f * 0.2;
            ro = ro * (1 - f) + 0.16 * f;
          }
        }
        // Tyre scuffs: long dark streaks, rough rubber deposit.
        for (const sc of scuffs) {
          const cx = Math.cos(sc.a);
          const cy = Math.sin(sc.a);
          let dx = u - sc.x;
          let dy = v - sc.y;
          dx -= Math.round(dx);
          dy -= Math.round(dy);
          const along = dx * cx + dy * cy;
          const across = -dx * cy + dy * cx;
          if (Math.abs(along) < sc.l && Math.abs(across) < sc.w * 3) {
            const f = Math.exp(-((across / sc.w) ** 2)) * (1 - (Math.abs(along) / sc.l) ** 2) * sc.k;
            r *= 1 - f;
            g *= 1 - f;
            b *= 1 - f * 0.95;
            ro = ro * (1 - f) + 0.6 * f;
          }
        }
        // Saw-cut joints every 4 m (half a tile).
        const jx = Math.min(Math.abs(u - 0.5), Math.min(u, 1 - u)) * 8;
        const jy = Math.min(Math.abs(v - 0.5), Math.min(v, 1 - v)) * 8;
        const joint = Math.min(jx, jy) < 0.008 ? 1 : 0;
        let h = (speck - 0.5) * 0.15 * (0.3 + worn) + (m - 0.5) * 0.3;
        if (joint) {
          r *= 0.45;
          g *= 0.45;
          b *= 0.45;
          ro = 0.85;
          h -= 2;
        }
        const i = (y * S + x) * 4;
        col[i] = Math.min(255, r * 255);
        col[i + 1] = Math.min(255, g * 255);
        col[i + 2] = Math.min(255, b * 255);
        col[i + 3] = 255;
        rough[i] = rough[i + 1] = rough[i + 2] = Math.min(255, ro * 255);
        rough[i + 3] = 255;
        height[y * S + x] = h;
      }
    }
    return {
      map: dataTexture(col, S, true),
      roughnessMap: dataTexture(rough, S, false),
      normalMap: normalFromHeight(height, S, S, 0.9),
    };
  });
}

/**
 * Insulated metal wall panel: 1 m wide, trapezoidal ribs every 333 mm,
 * grey-white factory coat with a dirt gradient climbing from the floor.
 * One tile = 4 m × 4 m. The dirt gradient lives in vertex colours instead.
 */
export function wallPanelTextures() {
  return memo('wallPanel', () => {
    const S = 512;
    const N = createNoise(23);
    const h = new Float32Array(S * S);
    const col = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / S) * 12; // 12 ribs per 4 m
        const f = u - Math.floor(u);
        // trapezoid rib profile
        const rib = f < 0.12 ? f / 0.12 : f < 0.3 ? 1 : f < 0.42 ? 1 - (f - 0.3) / 0.12 : 0;
        const seam = Math.abs((x / S) * 4 - Math.round((x / S) * 4)) < 0.003 ? -0.6 : 0;
        const n = N.fbm2(x / 60, y / 60, 4);
        h[y * S + x] = rib * 3.5 + seam * 4 + n * 0.08;
        const v = 0.78 + n * 0.03 - (rib < 0.05 ? 0.02 : 0) + seam * 0.1;
        const i = (y * S + x) * 4;
        col[i] = v * 247;
        col[i + 1] = v * 248;
        col[i + 2] = v * 246;
        col[i + 3] = 255;
      }
    }
    return { map: dataTexture(col, S, true), normalMap: normalFromHeight(h, S, S, 1.4) };
  });
}

/**
 * Saucer hull: circumferentially brushed titanium with radial panel seams and
 * ring seams. UV u runs around the lathe (24 panels), v along the profile.
 */
export function hullTextures(panels = 24, rings = [0.18, 0.36, 0.52, 0.62, 0.7, 0.86]) {
  return memo(`hull${panels}`, () => {
    const W = 2048;
    const H = 512;
    const N = createNoise(77);
    const rand = mulberry32(11);
    const height = new Float32Array(W * H);
    const rough = new Uint8Array(W * H * 4);
    const col = new Uint8Array(W * H * 4);
    const tint = [];
    for (let p = 0; p < panels; p++) tint.push((rand() - 0.5) * 0.05);
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const brush = N.noise2(x * 0.02, y * 2.4) * 0.5 + N.noise2(x * 0.004, y * 9) * 0.5;
        const pu = u * panels;
        const panel = Math.floor(pu);
        const fu = pu - panel;
        let seam = Math.min(fu, 1 - fu) < 0.004 ? 1 : 0;
        for (const r of rings) if (Math.abs(v - r) < 0.0035) seam = 1;
        // rivet rows beside ring seams
        let rivet = 0;
        for (const r of rings) {
          const dv = Math.abs(v - r - 0.012);
          if (dv < 0.004) {
            const k = (u * panels * 10) % 1;
            if (Math.abs(k - 0.5) < 0.08) rivet = 1;
          }
        }
        const smudge = N.fbm2(x / 180, y / 60, 4);
        height[y * W + x] = brush * 0.35 - seam * 3 + rivet * 1.2;
        const ro = 0.24 + brush * 0.05 + smudge * 0.08 + seam * 0.3 + tint[panel % panels] * 0.6;
        const i = (y * W + x) * 4;
        rough[i] = rough[i + 1] = rough[i + 2] = Math.max(0, Math.min(255, ro * 255));
        rough[i + 3] = 255;
        const c = 0.8 + tint[panel % panels] + smudge * 0.04 - seam * 0.35;
        col[i] = c * 236;
        col[i + 1] = c * 238;
        col[i + 2] = c * 242;
        col[i + 3] = 255;
      }
    }
    const mk = (d, srgb) => {
      const t = new DataTexture(d, W, H, RGBAFormat, UnsignedByteType);
      t.wrapS = RepeatWrapping;
      t.generateMipmaps = true;
      t.minFilter = LinearMipmapLinearFilter;
      t.magFilter = LinearFilter;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = SRGBColorSpace;
      t.needsUpdate = true;
      return t;
    };
    return { map: mk(col, true), roughnessMap: mk(rough, false), normalMap: normalFromHeight(height, W, H, 0.9, { wrapY: false }) };
  });
}

/** Pebbled leather (flight gloves): fine cellular grain + soft creases. */
export function leatherTextures() {
  return memo('leather', () => {
    const S = 512;
    const N = createNoise(91);
    const rand = mulberry32(17);
    // Worley-ish pebble grain
    const pts = [];
    const cells = 48;
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) pts.push([(i + rand()) / cells, (j + rand()) / cells]);
    const h = new Float32Array(S * S);
    const rough = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const v = y / S;
        const ci = Math.floor(u * cells);
        const cj = Math.floor(v * cells);
        let d1 = 9;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = (ci + di + cells) % cells;
            const jj = (cj + dj + cells) % cells;
            const p = pts[jj * cells + ii];
            let dx = u - p[0];
            let dy = v - p[1];
            dx -= Math.round(dx);
            dy -= Math.round(dy);
            const d = Math.sqrt(dx * dx + dy * dy) * cells;
            if (d < d1) d1 = d;
          }
        }
        const crease = Math.abs(N.noise2(x * 0.012, y * 0.05)) < 0.04 ? -0.6 : 0;
        h[y * S + x] = Math.min(1, d1) * -0.8 + crease + N.noise2(x * 0.3, y * 0.3) * 0.05;
        const i = (y * S + x) * 4;
        const ro = 0.5 + Math.min(1, d1) * 0.18 + crease * -0.1;
        rough[i] = rough[i + 1] = rough[i + 2] = Math.min(255, ro * 255);
        rough[i + 3] = 255;
      }
    }
    return { normalMap: normalFromHeight(h, S, S, 1.2), roughnessMap: dataTexture(rough, S, false) };
  });
}

/**
 * Apron concrete: 6.1 m (20 ft) slabs with sealed joints, a tone per slab,
 * spalled corners, hairline cracks, tyre marks down the lead-in and a few
 * fuel / hydraulic stains. One tile = 24.4 m (4 × 4 slabs); v runs along the
 * taxi direction.
 */
export function apronTextures() {
  return memo('apron', () => {
    const S = 1024;
    const P = S / 4; // px per slab
    const N = createNoise(91);
    const rand = mulberry32(17);
    const col = new Uint8Array(S * S * 4);
    const rough = new Uint8Array(S * S * 4);
    const height = new Float32Array(S * S);
    const mottle = tileableField(256, 5, 5, 93);
    const fine = tileableField(256, 36, 3, 94);
    const tone = [];
    for (let i = 0; i < 16; i++) tone.push((rand() - 0.5) * 0.07);
    const stains = [];
    for (let i = 0; i < 7; i++) stains.push({ x: rand(), y: rand(), r: 0.008 + rand() * 0.03, k: 0.3 + rand() * 0.5 });
    // tyre marks: pairs of soft streaks along v, broken up by noise
    const tyres = [];
    for (let i = 0; i < 5; i++) {
      const u = 0.38 + rand() * 0.24;
      tyres.push({ u, w: 0.0035 + rand() * 0.003, k: 0.05 + rand() * 0.07 }, { u: u + 0.07, w: 0.0035 + rand() * 0.003, k: 0.05 + rand() * 0.07 });
    }
    // hairline cracks and corner spalls, stamped along random walks
    const crack = new Float32Array(S * S);
    const stamp = (x, y, r, k) => {
      const ri = Math.ceil(r);
      for (let dy = -ri; dy <= ri; dy++) {
        for (let dx = -ri; dx <= ri; dx++) {
          const d = Math.hypot(dx, dy) / r;
          if (d > 1) continue;
          const i = (((y + dy) % S) + S) % S * S + ((((x + dx) % S) + S) % S);
          crack[i] = Math.max(crack[i], (1 - d) * k);
        }
      }
    };
    for (let c = 0; c < 14; c++) {
      let x = Math.floor(rand() * 4) * P + (rand() < 0.5 ? 0 : P * rand());
      let y = Math.floor(rand() * 4) * P + P * rand();
      let a = rand() * Math.PI * 2;
      const len = P * (0.25 + rand() * 0.6);
      for (let s = 0; s < len; s += 0.6) {
        a += N.noise2(c * 13.1, s * 0.03) * 0.12;
        x += Math.cos(a) * 0.6;
        y += Math.sin(a) * 0.6;
        stamp(Math.round(x), Math.round(y), 1.1, 1);
      }
    }
    for (let i = 0; i < 10; i++) {
      // a chipped slab corner
      const cx = Math.floor(rand() * 4) * P;
      const cy = Math.floor(rand() * 4) * P;
      for (let k = 0; k < 6; k++) stamp(cx + Math.round((rand() - 0.5) * 9), cy + Math.round((rand() - 0.5) * 9), 2 + rand() * 3, 0.8);
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const v = y / S;
        const i = y * S + x;
        const m = mottle[((y >> 2) % 256) * 256 + ((x >> 2) % 256)];
        const f = fine[(y % 256) * 256 + (x % 256)];
        const slab = Math.floor(v * 4) * 4 + Math.floor(u * 4);
        // distance to the nearest joint, px
        const fx = x % P;
        const fy = y % P;
        const dj = Math.min(fx, P - fx, fy, P - fy);
        const joint = dj < 1.3 ? 1 : 0;
        const bevel = dj < 3.5 ? 1 - dj / 3.5 : 0;
        let t = 0.7 + tone[slab] + (m - 0.5) * 0.08 + (f - 0.5) * 0.06;
        let ro = 0.84 + (f - 0.5) * 0.08;
        // tyre rubber along the lead-in
        for (const ty of tyres) {
          const d = Math.abs(u - ty.u) / ty.w;
          if (d < 1.6) {
            const br = N.noise2(x * 0.004 + ty.u * 50, y * 0.02) * 0.5 + 0.5;
            const k = Math.exp(-d * d) * ty.k * smooth(br);
            t *= 1 - k;
            ro -= k * 0.4;
          }
        }
        for (const s of stains) {
          let dx = Math.abs(u - s.x);
          let dy = Math.abs(v - s.y);
          dx = Math.min(dx, 1 - dx);
          dy = Math.min(dy, 1 - dy);
          const d = Math.sqrt(dx * dx + dy * dy) / s.r;
          if (d < 1.5) {
            const edge = N.noise2(x * 0.05 + s.x * 30, y * 0.05) * 0.3;
            const k = Math.max(0, 1 - Math.max(0, d + edge - 0.25)) * s.k;
            t *= 1 - k * 0.3;
            ro = ro * (1 - k) + 0.42 * k;
          }
        }
        const cr = crack[i];
        t *= 1 - cr * 0.35 - joint * 0.55 - bevel * 0.06;
        ro += joint * 0.1;
        const o = i * 4;
        col[o] = Math.min(255, t * 236);
        col[o + 1] = Math.min(255, t * 230);
        col[o + 2] = Math.min(255, t * 218);
        col[o + 3] = 255;
        rough[o] = rough[o + 1] = rough[o + 2] = Math.max(0, Math.min(255, ro * 255));
        rough[o + 3] = 255;
        height[i] = (f - 0.5) * 0.12 - joint * 1.0 - bevel * 0.35 - cr * 0.5;
      }
    }
    return {
      map: dataTexture(col, S, true),
      roughnessMap: dataTexture(rough, S, false),
      normalMap: normalFromHeight(height, S, S, 1.6),
    };
  });
}

function smooth(x) {
  const c = Math.max(0, Math.min(1, (x - 0.35) / 0.4));
  return c * c * (3 - 2 * c);
}

/** Tileable value noise on an n × n wrapped lattice (x, y in lattice units). */
function latticeNoise(n, seed) {
  const r = mulberry32(seed);
  const lat = new Float32Array(n * n);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % n) + n) % n;
    const y0 = ((yi % n) + n) % n;
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const a = lat[y0 * n + x0];
    const b = lat[y0 * n + x1];
    const c = lat[y1 * n + x0];
    const d = lat[y1 * n + x1];
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

/** Tileable jittered-grid Voronoi: F1, F2 (cell units) and the nearest cell's random id. */
function voronoiField(G, seed) {
  const r = mulberry32(seed);
  const pts = new Float32Array(G * G * 2);
  const ids = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) {
    pts[i * 2] = 0.1 + r() * 0.8;
    pts[i * 2 + 1] = 0.1 + r() * 0.8;
    ids[i] = r();
  }
  const out = [0, 0, 0];
  return (x, y) => {
    const gx = x * G;
    const gy = y * G;
    const cx = Math.floor(gx);
    const cy = Math.floor(gy);
    let f1 = 9;
    let f2 = 9;
    let id = 0;
    for (let j = -1; j <= 1; j++) {
      const ny = cy + j;
      const wy = ((ny % G) + G) % G;
      for (let i = -1; i <= 1; i++) {
        const nx = cx + i;
        const k = wy * G + (((nx % G) + G) % G);
        const dx = nx + pts[k * 2] - gx;
        const dy = ny + pts[k * 2 + 1] - gy;
        const d = dx * dx + dy * dy;
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = ids[k];
        } else if (d < f2) f2 = d;
      }
    }
    out[0] = Math.sqrt(f1);
    out[1] = Math.sqrt(f2);
    out[2] = id;
    return out;
  };
}

/**
 * Lakebed / hardpan detail for the ground overlay around the site: dried clay
 * broken into polygons (an open primary network with finer, half-healed cracks
 * inside), curled polygon rims, silt drifts that fill the cracks, scattered
 * pebbles and grain. One tile = 4 m, multiplied over the satellite imagery.
 *
 *   r    : albedo factor × 0.8 (averages to exactly 1.0, so distance fades are neutral)
 *   g, b : surface slope dh/du, dh/dv (0.5 = flat), for raking-sun relief of the crust
 *   a    : pebble albedo, 0.5 = none (the shader scales it by the gravel mask; pebbles
 *          carry no relief — lit domes at this size read as craters)
 */
export function lakebedTextures() {
  return memo('lakebed', () => {
    const S = 1024;
    const px = 4 / S; // metres per texel
    const rand = mulberry32(4242);
    const primary = voronoiField(5, 11); // ~0.8 m polygons
    const secondary = voronoiField(14, 12); // ~0.29 m
    const warp = latticeNoise(24, 13);
    const warp2 = latticeNoise(24, 14);
    const gap = latticeNoise(10, 15); // crack opening along the network
    const heal = latticeNoise(18, 16); // which fine cracks are still open
    const drift = latticeNoise(6, 17); // silt drifts filling cracks
    const grainA = latticeNoise(128, 18);
    const grainB = latticeNoise(512, 19);
    const alb = new Float32Array(S * S);
    const hgt = new Float32Array(S * S);
    const peb = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S;
        // wiggle the polygon edges (a few cm) so cracks never run dead straight
        const wu = u + (warp(u * 24, v * 24) - 0.5) * 0.009;
        const wv = v + (warp2(u * 24, v * 24) - 0.5) * 0.009;
        const p = primary(((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1);
        const e1 = p[1] - p[0];
        const id = p[2];
        const s2 = secondary(((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1);
        const e2 = s2[1] - s2[0];
        const fill = smooth(drift(u * 6, v * 6) * 0.9 + 0.12);
        // primary: 3–8 mm half-width in 0.8 m cells → F2−F1 threshold ≈ 2·hw/0.8
        const w1 = (0.0075 + gap(u * 10, v * 10) * 0.013) * (1 - fill * 0.7);
        const c1 = Math.max(0, 1 - e1 / w1);
        const rim = Math.max(0, 1 - e1 / (w1 * 5)) * (1 - c1);
        // secondary: hairline, mostly healed
        const open = Math.max(0, (heal(u * 18, v * 18) - 0.45) / 0.55) * (1 - fill);
        const w2 = 0.012 * open;
        const c2 = w2 > 0 ? Math.max(0, 1 - e2 / w2) : 0;
        const g1 = grainA(u * 128, v * 128) - 0.5;
        const g2 = grainB(u * 512, v * 512) - 0.5;
        const i = y * S + x;
        alb[i] = (1 + (id - 0.5) * 0.07 + g1 * 0.05 + g2 * 0.07 + rim * 0.04 + fill * 0.03) * (1 - c1 * 0.58) * (1 - c2 * 0.32);
        hgt[i] = rim * rim * 0.0016 - c1 * 0.006 - c2 * 0.0015 + g1 * 0.0006 + g2 * 0.0004;
      }
    }
    // pebbles: grit to ~3 cm, mostly dark varnished basalt, a little pale quartz
    for (let k = 0; k < 1100; k++) {
      const cx = rand() * S;
      const cy = rand() * S;
      const r = (0.003 + rand() ** 4 * 0.013) / px;
      const tone = rand() < 0.82 ? -(0.12 + rand() * 0.4) : 0.05 + rand() * 0.12;
      const ax = 0.7 + rand() * 0.6; // elongation
      const rot = rand() * Math.PI;
      const ca = Math.cos(rot);
      const sa = Math.sin(rot);
      const ri = Math.ceil(r * 1.4);
      for (let dy = -ri; dy <= ri; dy++) {
        for (let dx = -ri; dx <= ri; dx++) {
          const lx = (dx * ca + dy * sa) / (r * ax);
          const ly = (-dx * sa + dy * ca) / (r / ax);
          const d2 = lx * lx + ly * ly;
          if (d2 > 1) continue;
          const i = ((((Math.round(cy) + dy) % S) + S) % S) * S + ((((Math.round(cx) + dx) % S) + S) % S);
          const dome = Math.sqrt(1 - d2);
          peb[i] = tone * (0.7 + 0.3 * dome);
        }
      }
    }
    let mean = 0;
    for (let i = 0; i < S * S; i++) mean += alb[i];
    mean /= S * S;
    const data = new Uint8Array(S * S * 4);
    const at = (x, y) => hgt[((y + S) % S) * S + ((x + S) % S)];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const su = Math.max(-1, Math.min(1, (at(x + 1, y) - at(x - 1, y)) / (2 * px)));
        const sv = Math.max(-1, Math.min(1, (at(x, y + 1) - at(x, y - 1)) / (2 * px)));
        data[i * 4] = Math.min(255, (alb[i] / mean) * 0.8 * 255);
        data[i * 4 + 1] = 128 + su * 127;
        data[i * 4 + 2] = 128 + sv * 127;
        data[i * 4 + 3] = 128 + Math.max(-0.5, Math.min(0.5, peb[i])) * 254;
      }
    }
    return { detail: dataTexture(data, S, false) };
  });
}

/** Soft tileable noise for large-scale patchiness: r ≈ 1/4, g ≈ 1/16, b ≈ 1/64 of the tile. */
export function macroNoiseTexture() {
  return memo('macroNoise', () => {
    const S = 256;
    const a = latticeNoise(4, 31);
    const b = latticeNoise(16, 32);
    const c = latticeNoise(64, 33);
    const b2 = latticeNoise(32, 34);
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const v = y / S;
        const i = (y * S + x) * 4;
        data[i] = (a(u * 4, v * 4) * 0.7 + b(u * 16, v * 16) * 0.3) * 255;
        data[i + 1] = (b(u * 16, v * 16) * 0.65 + b2(u * 32, v * 32) * 0.35) * 255;
        data[i + 2] = c(u * 64, v * 64) * 255;
        data[i + 3] = 255;
      }
    }
    return dataTexture(data, S, false);
  });
}

/** Nomex twill (flight suit): diagonal weave + slub noise. */
export function twillTextures() {
  return memo('twill', () => {
    const S = 256;
    const N = createNoise(33);
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = ((x + y) / S) * 64;
        const twill = Math.sin(d * Math.PI * 2) * 0.5 + 0.5;
        const cross = Math.sin((x / S) * Math.PI * 2 * 96) * 0.15;
        h[y * S + x] = twill * 0.7 + cross + N.noise2(x * 0.05, y * 0.4) * 0.25;
      }
    }
    return { normalMap: normalFromHeight(h, S, S, 1.1) };
  });
}

/** Generic painted-steel micro roughness + chips (props, columns). */
export function paintedSteelTextures() {
  return memo('paintSteel', () => {
    const S = 512;
    const f = tileableField(S, 18, 4, 61);
    const chips = tileableField(S, 30, 3, 62);
    const h = new Float32Array(S * S);
    const rough = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      const chip = chips[i] > 0.78 ? 1 : 0;
      h[i] = f[i] * 0.3 - chip * 0.8;
      const ro = 0.42 + (f[i] - 0.5) * 0.15 + chip * 0.25;
      rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = Math.min(255, ro * 255);
      rough[i * 4 + 3] = 255;
    }
    return { normalMap: normalFromHeight(h, S, S, 1.0), roughnessMap: dataTexture(rough, S, false) };
  });
}

/** Big signage / stencil texture helper (white or coloured text on a panel). */
export function signTexture(lines, { w = 1024, h = 256, bg = '#c9332b', fg = '#ffffff', font = '700', family = 'Chakra Petch, Arial Narrow, sans-serif', size = 0.34, border = 0, align = 'center' } = {}) {
  return canvasTexture(w, h, (g) => {
    if (bg) {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
    }
    if (border) {
      g.strokeStyle = fg;
      g.lineWidth = border;
      g.strokeRect(border, border, w - border * 2, h - border * 2);
    }
    g.fillStyle = fg;
    g.textAlign = align;
    g.textBaseline = 'middle';
    const n = lines.length;
    lines.forEach((line, k) => {
      const big = typeof line === 'object' ? line.size : size;
      const text = typeof line === 'object' ? line.text : line;
      g.font = `${font} ${Math.round(h * big)}px ${family}`;
      const x = align === 'center' ? w / 2 : align === 'left' ? w * 0.05 : w * 0.95;
      g.fillText(text, x, (h * (k + 0.5)) / n);
    });
    // light grime so signs never look like UI
    const img = g.getImageData(0, 0, w, h);
    const rand = mulberry32(lines.join('').length + 3);
    for (let i = 0; i < img.data.length; i += 4) {
      const d = (rand() - 0.5) * 14;
      img.data[i] += d;
      img.data[i + 1] += d;
      img.data[i + 2] += d;
    }
    g.putImageData(img, 0, 0);
  });
}
