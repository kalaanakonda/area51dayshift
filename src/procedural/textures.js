import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { createNoise } from '../core/noise.js';
import { mulberry32 } from '../core/math.js';

/**
 * Procedural textures, generated once at load. Each one stands in for a
 * texture set that the BlendKit asset bible describes (see docs/).
 */

const cache = new Map();
function memo(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

export function canvasTexture(w, h, draw, { srgb = true, repeat = false, anisotropy = 8 } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  return t;
}

/** Height field → tangent-space normal map (DataTexture, linear). */
export function heightToNormal(height, size, strength = 2) {
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Tileable fbm value field 0..1 (periodic by sampling a torus in 4D-ish via 3D noise). */
export function tileableField(size, scale, octaves, seed) {
  const N = createNoise(seed);
  const out = new Float32Array(size * size);
  const R = scale / (2 * Math.PI);
  for (let y = 0; y < size; y++) {
    const ay = (y / size) * Math.PI * 2;
    for (let x = 0; x < size; x++) {
      const ax = (x / size) * Math.PI * 2;
      // Map to a cylinder in x and a phase-shift in y — cheap and seamless enough.
      const v = N.fbm3(Math.cos(ax) * R, Math.sin(ax) * R + Math.cos(ay) * R, Math.sin(ay) * R, octaves);
      out[y * size + x] = v * 0.5 + 0.5;
    }
  }
  return out;
}

// ---------------------------------------------------------------- shared

/** Soft puff sprite for vapour, dust and smoke (alpha in A, white RGB). */
export function puffTexture() {
  return memo('puff', () => {
    const size = 128;
    const field = tileableField(size, 5, 5, 41);
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1) - 0.5;
        const v = y / (size - 1) - 0.5;
        const r = Math.sqrt(u * u + v * v) * 2;
        const n = field[y * size + x];
        const a = Math.max(0, 1 - r) ** 1.6 * (0.55 + 0.75 * n);
        const i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = Math.min(255, a * 255);
      }
    }
    const t = new DataTexture(data, size, size);
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.needsUpdate = true;
    return t;
  });
}

/** Woven technical fabric normal map (suit sleeves, gloves). */
export function fabricNormal() {
  return memo('fabric', () => {
    const size = 256;
    const h = new Float32Array(size * size);
    const N = createNoise(7);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const wx = Math.sin((x / size) * Math.PI * 64) * 0.5 + 0.5;
        const wy = Math.sin((y / size) * Math.PI * 64) * 0.5 + 0.5;
        const over = ((Math.floor((x / size) * 32) + Math.floor((y / size) * 32)) % 2) === 0 ? wx : wy;
        h[y * size + x] = over * 0.6 + N.noise2(x * 0.08, y * 0.08) * 0.25;
      }
    }
    return heightToNormal(h, size, 1.6);
  });
}

/** Fine noise normal map (cast metal, powder coat, regolith grain). */
export function grainNormal(seed = 3, scale = 24, strength = 2.2) {
  return memo(`grain${seed}_${scale}`, () => {
    const size = 256;
    const f = tileableField(size, scale, 4, seed);
    return heightToNormal(f, size, strength);
  });
}

// ---------------------------------------------------------------- Starbase

export function concreteTexture() {
  return memo('concrete', () =>
    canvasTexture(
      512,
      512,
      (g, w, h) => {
        const N = createNoise(11);
        const img = g.createImageData(w, h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const n = N.fbm2(x / 45, y / 45, 5) * 0.5 + 0.5;
            const fine = N.noise2(x / 1.6, y / 1.6) * 0.5 + 0.5;
            const stain = Math.max(0, N.fbm2(x / 130 + 9, y / 130, 3)) * 0.5;
            let v = 0.52 + (n - 0.5) * 0.22 + (fine - 0.5) * 0.08 - stain * 0.25;
            const i = (y * w + x) * 4;
            img.data[i] = v * 255 * 0.98;
            img.data[i + 1] = v * 255 * 0.97;
            img.data[i + 2] = v * 255 * 0.95;
            img.data[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
        // Slab joints every quarter (texture covers 24 m → 6 m slabs).
        g.strokeStyle = 'rgba(30,30,30,0.55)';
        g.lineWidth = 2;
        for (let k = 0; k <= 4; k++) {
          const p = (k / 4) * w;
          g.beginPath();
          g.moveTo(p, 0);
          g.lineTo(p, h);
          g.stroke();
          g.beginPath();
          g.moveTo(0, p);
          g.lineTo(w, p);
          g.stroke();
        }
      },
      { repeat: true }
    )
  );
}

/** Coastal scrub / sand ground. Large tile, low frequency variation. */
export function groundTexture() {
  return memo('ground', () =>
    canvasTexture(
      512,
      512,
      (g, w, h) => {
        const N = createNoise(23);
        const img = g.createImageData(w, h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const n = N.fbm2(x / 35, y / 35, 5) * 0.5 + 0.5;
            const tuft = N.noise2(x / 2, y / 2) * 0.5 + 0.5;
            const sand = [0.46, 0.42, 0.34];
            const grass = [0.26, 0.27, 0.18];
            const t = Math.min(1, Math.max(0, n * 1.4 - 0.2));
            const i = (y * w + x) * 4;
            const k = 0.85 + tuft * 0.3;
            img.data[i] = (sand[0] * (1 - t) + grass[0] * t) * k * 255;
            img.data[i + 1] = (sand[1] * (1 - t) + grass[1] * t) * k * 255;
            img.data[i + 2] = (sand[2] * (1 - t) + grass[2] * t) * k * 255;
            img.data[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
      },
      { repeat: true }
    )
  );
}

/** Steel walkway grating: alpha cut-out (white = solid). */
export function gratingAlpha() {
  return memo('grating', () =>
    canvasTexture(
      256,
      256,
      (g, w, h) => {
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff';
        const bars = 8;
        for (let i = 0; i <= bars; i++) {
          const p = (i / bars) * w;
          g.fillRect(p - 3, 0, 6, h); // bearing bars
        }
        for (let i = 0; i <= 32; i++) {
          const p = (i / 32) * h;
          g.fillRect(0, p - 1.5, w, 3); // cross rods
        }
      },
      { srgb: false, repeat: true }
    )
  );
}

/** Black/yellow hazard stripes. */
export function hazardTexture() {
  return memo('hazard', () =>
    canvasTexture(
      256,
      64,
      (g, w, h) => {
        g.fillStyle = '#d9a514';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#121212';
        for (let x = -h; x < w + h; x += 48) {
          g.beginPath();
          g.moveTo(x, h);
          g.lineTo(x + 24, h);
          g.lineTo(x + 24 + h, 0);
          g.lineTo(x + h, 0);
          g.closePath();
          g.fill();
        }
      },
      { repeat: true }
    )
  );
}

/** Painted label / signage (stencil style). */
export function labelTexture(lines, { w = 512, h = 128, bg = '#d8d6d0', fg = '#1a1a1a', font = 500, size = 0.42, align = 'center' } = {}) {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.textAlign = align;
    g.textBaseline = 'middle';
    const arr = Array.isArray(lines) ? lines : [lines];
    const lh = h / arr.length;
    arr.forEach((line, i) => {
      g.font = `${font} ${Math.floor(lh * size * (i === 0 ? 1.1 : 0.85))}px "IBM Plex Mono", monospace`;
      g.fillText(line, align === 'center' ? w / 2 : 24, lh * (i + 0.5));
    });
  });
}

/** Vented hot-stage ring: vertical slots. */
export function ventTexture() {
  return memo('vent', () =>
    canvasTexture(
      1024,
      64,
      (g, w, h) => {
        g.fillStyle = '#9ea2a6';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#0c0c0c';
        const n = 48;
        for (let i = 0; i < n; i++) {
          const x = (i / n) * w + 4;
          g.fillRect(x, h * 0.18, w / n - 9, h * 0.64);
        }
      },
      { repeat: true }
    )
  );
}

/** Grid-fin lattice alpha. */
export function gridFinAlpha() {
  return memo('gridfin', () =>
    canvasTexture(
      256,
      256,
      (g, w, h) => {
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        g.strokeStyle = '#fff';
        g.lineWidth = 7;
        for (let i = -w; i < w * 2; i += 26) {
          g.beginPath();
          g.moveTo(i, 0);
          g.lineTo(i + h, h);
          g.stroke();
          g.beginPath();
          g.moveTo(i, h);
          g.lineTo(i + h, 0);
          g.stroke();
        }
        g.lineWidth = 16;
        g.strokeRect(0, 0, w, h);
      },
      { srgb: false }
    )
  );
}

/** Mars regolith albedo (tileable) + normal. */
export function regolithTextures() {
  return memo('regolith', () => {
    const size = 512;
    const f = tileableField(size, 9, 6, 77);
    const fine = tileableField(size, 60, 3, 78);
    const data = new Uint8Array(size * size * 4);
    const rand = mulberry32(5);
    for (let i = 0; i < size * size; i++) {
      const n = f[i];
      const k = 0.78 + n * 0.32 + (fine[i] - 0.5) * 0.18;
      const pebble = rand() < 0.012 ? 0.55 : 1;
      data[i * 4] = Math.min(255, 168 * k * pebble);
      data[i * 4 + 1] = Math.min(255, 104 * k * pebble);
      data[i * 4 + 2] = Math.min(255, 66 * k * pebble);
      data[i * 4 + 3] = 255;
    }
    const albedo = new DataTexture(data, size, size);
    albedo.colorSpace = SRGBColorSpace;
    albedo.wrapS = albedo.wrapT = RepeatWrapping;
    albedo.generateMipmaps = true;
    albedo.minFilter = LinearMipmapLinearFilter;
    albedo.magFilter = LinearFilter;
    albedo.anisotropy = 8;
    albedo.needsUpdate = true;
    const h = new Float32Array(size * size);
    for (let i = 0; i < h.length; i++) h[i] = f[i] * 0.6 + fine[i] * 0.6;
    const normal = heightToNormal(h, size, 3.0);
    return { albedo, normal };
  });
}

/** Bootprint height stamp → normal + darkening mask (Scene 5 hero detail). */
export function bootprintTexture() {
  return memo('bootprint', () =>
    canvasTexture(
      256,
      512,
      (g, w, h) => {
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        const grad = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.5);
        grad.addColorStop(0, 'rgba(255,255,255,0.9)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        // Sole outline: toe + heel
        g.beginPath();
        g.ellipse(w / 2, h * 0.32, w * 0.36, h * 0.24, 0, 0, Math.PI * 2);
        g.ellipse(w / 2, h * 0.74, w * 0.3, h * 0.18, 0, 0, Math.PI * 2);
        g.fill();
        // Lugs (the tread pattern people remember)
        g.fillStyle = 'rgba(0,0,0,0.75)';
        for (let y = 0.12; y < 0.92; y += 0.065) {
          const ww = y < 0.56 ? 0.56 : 0.46;
          g.fillRect(w * (0.5 - ww / 2), h * y, w * ww, h * 0.022);
        }
      },
      { srgb: false }
    )
  );
}

// ---------------------------------------------------------------- ship interior

/** Draw into a square canvas and read it back as a 0..1 height field (red channel). */
function canvasHeight(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const px = g.getImageData(0, 0, size, size).data;
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = px[i * 4] / 255;
  return h;
}

/**
 * Crew-deck wall panels: off-white composite, 0.5 m × 1 m panels, recessed
 * seams, captive fasteners. One texture tile = 2 m × 2 m.
 */
export function cabinPanelTextures() {
  return memo('cabinPanel', () => {
    const rand = mulberry32(12);
    const map = canvasTexture(
      1024,
      1024,
      (g, w, h) => {
        g.fillStyle = '#d6d4ce';
        g.fillRect(0, 0, w, h);
        for (let i = 0; i < 8; i++) {
          for (let j = 0; j < 2; j++) {
            const t = 0.95 + rand() * 0.07;
            g.fillStyle = `rgba(${Math.floor(214 * t)},${Math.floor(212 * t)},${Math.floor(206 * t)},1)`;
            g.fillRect(i * 128 + 2, j * 512 + 2, 124, 508);
          }
        }
        g.fillStyle = '#5d5f62';
        for (let x = 0; x <= w; x += 256) g.fillRect(x - 2, 0, 4, h);
        for (let y = 0; y <= h; y += 512) g.fillRect(0, y - 2, w, 4);
        g.fillStyle = '#8b8c8e';
        for (let x = 0; x < w; x += 256) {
          for (let y = 0; y < h; y += 512) {
            for (const [dx, dy] of [[14, 14], [242, 14], [14, 498], [242, 498], [128, 14], [128, 498]]) {
              g.beginPath();
              g.arc(x + dx, y + dy, 4.5, 0, Math.PI * 2);
              g.fill();
            }
          }
        }
        // Faint scuffs near hand height on some panels
        g.fillStyle = 'rgba(80,78,74,0.05)';
        for (let i = 0; i < 40; i++) g.fillRect(rand() * w, 380 + rand() * 300, 20 + rand() * 80, 2 + rand() * 6);
      },
      { repeat: true }
    );
    const hgt = canvasHeight(512, (g, n) => {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, n, n);
      g.fillStyle = '#000';
      for (let x = 0; x <= n; x += 128) g.fillRect(x - 2, 0, 4, n);
      for (let y = 0; y <= n; y += 256) g.fillRect(0, y - 2, n, 4);
      g.fillStyle = '#9a9a9a';
      for (let x = 0; x < n; x += 128) for (let y = 0; y < n; y += 256) for (const [dx, dy] of [[7, 7], [121, 7], [7, 249], [121, 249]]) {
        g.beginPath();
        g.arc(x + dx, y + dy, 2.5, 0, Math.PI * 2);
        g.fill();
      }
    });
    return { map, normal: heightToNormal(hgt, 512, 3.5) };
  });
}

/** Storm-shelter water wall: quilted Nomex water bags, stitched, blue-grey. 1 tile = 0.6 m. */
export function quiltTextures() {
  return memo('quilt', () => {
    const map = canvasTexture(
      512,
      512,
      (g, w, h) => {
        g.fillStyle = '#5f6b74';
        g.fillRect(0, 0, w, h);
        const n = 4;
        const s = w / n;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const gr = g.createRadialGradient(i * s + s / 2, j * s + s / 2, 4, i * s + s / 2, j * s + s / 2, s * 0.7);
            gr.addColorStop(0, '#7d8a93');
            gr.addColorStop(1, '#4c565e');
            g.fillStyle = gr;
            g.fillRect(i * s + 3, j * s + 3, s - 6, s - 6);
          }
        }
        g.strokeStyle = 'rgba(30,34,38,0.8)';
        g.setLineDash([6, 5]);
        g.lineWidth = 2;
        for (let i = 0; i <= n; i++) {
          g.beginPath();
          g.moveTo(i * s, 0);
          g.lineTo(i * s, h);
          g.stroke();
          g.beginPath();
          g.moveTo(0, i * s);
          g.lineTo(w, i * s);
          g.stroke();
        }
      },
      { repeat: true }
    );
    const hgt = new Float32Array(256 * 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const u = ((x / 64) % 1) - 0.5;
        const v = ((y / 64) % 1) - 0.5;
        hgt[y * 256 + x] = Math.cos(u * Math.PI) * Math.cos(v * Math.PI);
      }
    }
    return { map, normal: heightToNormal(hgt, 256, 6) };
  });
}

/** Deck floor: dark grey anti-slip panels with a raised grip pattern. 1 tile = 1 m. */
export function deckFloorTextures() {
  return memo('deckFloor', () => {
    const map = canvasTexture(
      512,
      512,
      (g, w, h) => {
        g.fillStyle = '#2f3236';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#383b40';
        for (let y = 8; y < h; y += 16) for (let x = (y / 16) % 2 ? 8 : 0; x < w; x += 16) g.fillRect(x, y, 6, 3);
        g.fillStyle = '#16181a';
        g.fillRect(0, 0, w, 4);
        g.fillRect(0, 0, 4, h);
      },
      { repeat: true }
    );
    const hgt = canvasHeight(256, (g, n) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, n, n);
      g.fillStyle = '#fff';
      for (let y = 4; y < n; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < n; x += 8) g.fillRect(x, y, 3, 2);
    });
    return { map, normal: heightToNormal(hgt, 256, 2.0) };
  });
}
