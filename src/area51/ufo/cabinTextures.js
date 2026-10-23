import { CanvasTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { tileableField } from '../../procedural/textures.js';
import { normalFromHeight } from '../textures.js';
import { mulberry32 } from '../../core/math.js';

/**
 * Canvas / data textures for ARV-3's cabin (cabin.js): the console deck, the
 * tread-plate floor, the tub wall panels, quilted seat cushions, and the
 * legend atlas that every switch panel is printed on.
 */
export const FONT = '"Chakra Petch", "IBM Plex Mono", sans-serif';
export const MONO = '"IBM Plex Mono", monospace';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function tex(c, { srgb = true, repeat = true } = {}) {
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  return t;
}

/** Greyscale canvas (R) → Float32 height field. */
function heights(c) {
  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const h = new Float32Array(c.width * c.height);
  for (let i = 0; i < h.length; i++) h[i] = px[i * 4] / 255;
  return h;
}

/** Per-pixel roughness (0..1, indexed like a canvas: row 0 on top) → linear DataTexture (three reads G). */
function roughTex(S, fn) {
  const d = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const v = Math.max(0, Math.min(255, fn(i) * 255));
    const o = ((S - 1 - Math.floor(i / S)) * S + (i % S)) * 4;
    d[o] = d[o + 1] = d[o + 2] = v;
    d[o + 3] = 255;
  }
  const t = new DataTexture(d, S, S, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Captive (Dzus) fastener head: domed ring with a slot. */
export function fastener(g, x, y, r, a = 0.6) {
  const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  gr.addColorStop(0, '#8d9196');
  gr.addColorStop(1, '#3b3e42');
  g.fillStyle = gr;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(10,10,12,0.9)';
  g.lineWidth = Math.max(1, r * 0.28);
  g.beginPath();
  g.moveTo(x - Math.cos(a) * r * 0.7, y - Math.sin(a) * r * 0.7);
  g.lineTo(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7);
  g.stroke();
}

/** Phillips pan-head screw. */
export function screw(g, x, y, r, a = 0.3) {
  fastener(g, x, y, r, a);
  g.beginPath();
  g.moveTo(x - Math.cos(a + Math.PI / 2) * r * 0.7, y - Math.sin(a + Math.PI / 2) * r * 0.7);
  g.lineTo(x + Math.cos(a + Math.PI / 2) * r * 0.7, y + Math.sin(a + Math.PI / 2) * r * 0.7);
  g.stroke();
}

/**
 * Console carcass + deck: dark charcoal paint over 0.25 m Dzus panels, polished
 * where hands rest, chipped on the edges. One tile = 0.5 m.
 */
export function deckTextures() {
  const S = 512;
  const rand = mulberry32(7);
  const f = tileableField(S, 5, 4, 41);
  const fine = tileableField(S, 40, 3, 42);
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 44 + (f[i] - 0.5) * 14 + (fine[i] - 0.5) * 6;
    img.data[i * 4] = v * 0.96;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v * 1.07;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const hc = canvas(S, S);
  const h = hc.getContext('2d');
  h.fillStyle = '#808080';
  h.fillRect(0, 0, S, S);
  // panel seams
  g.fillStyle = 'rgba(6,7,8,0.95)';
  h.fillStyle = '#000';
  for (const x of [0, 256]) {
    g.fillRect(x - 1.5, 0, 3, S);
    h.fillRect(x - 2, 0, 4, S);
  }
  for (const y of [0, 256]) {
    g.fillRect(0, y - 1.5, S, 3);
    h.fillRect(0, y - 2, S, 4);
  }
  // edge highlight on each panel (paint wear on the lip)
  g.strokeStyle = 'rgba(120,124,130,0.18)';
  g.lineWidth = 2;
  for (const x of [0, 256]) for (const y of [0, 256]) g.strokeRect(x + 4, y + 4, 248, 248);
  for (const px of [0, 256]) {
    for (const py of [0, 256]) {
      for (const [dx, dy] of [[12, 12], [244, 12], [12, 244], [244, 244], [128, 12], [128, 244], [12, 128], [244, 128]]) {
        fastener(g, px + dx, py + dy, 5.5, rand() * Math.PI);
        h.fillStyle = '#d0d0d0';
        h.beginPath();
        h.arc(px + dx, py + dy, 5.5, 0, Math.PI * 2);
        h.fill();
      }
    }
  }
  // scuffs and smudges
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '150,150,155' : '10,10,12'},${0.04 + rand() * 0.06})`;
    g.save();
    g.translate(rand() * S, rand() * S);
    g.rotate(rand() * Math.PI);
    g.fillRect(0, 0, 8 + rand() * 40, 1 + rand() * 3);
    g.restore();
  }
  const rough = roughTex(S, (i) => 0.52 + (f[i] - 0.5) * 0.25 + (fine[i] - 0.5) * 0.12);
  return { map: tex(c), normalMap: normalFromHeight(heights(hc), S, S, 2.5, { topDown: true }), roughnessMap: rough };
}

/** Aluminium tread plate (raised lugs, worn bright on top, grime in the valleys). One tile = 0.4 m. */
export function treadTextures() {
  const S = 512;
  const rand = mulberry32(19);
  const f = tileableField(S, 4, 4, 51);
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const hc = canvas(S, S);
  const h = hc.getContext('2d');
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 58 + (f[i] - 0.5) * 26;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v * 1.01;
    img.data[i * 4 + 2] = v * 1.04;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  h.fillStyle = '#000';
  h.fillRect(0, 0, S, S);
  h.filter = 'blur(1.6px)';
  const step = 32;
  for (let j = -1; j <= S / step; j++) {
    for (let i = -1; i <= S / step; i++) {
      const x = i * step + (j % 2 ? step / 2 : 0);
      const y = j * step;
      const a = (i + j) % 2 ? Math.PI / 4 : -Math.PI / 4;
      for (const ctx of [g, h]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.fillStyle = ctx === g ? `rgba(150,154,160,${0.35 + rand() * 0.25})` : '#fff';
        ctx.beginPath();
        ctx.ellipse(0, 0, 11, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
  h.filter = 'none';
  const hh = heights(hc);
  // grime in the valleys, polish on the lugs
  const px = g.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const k = 1 - hh[i];
    const dirt = k * (0.25 + f[i] * 0.35);
    px.data[i * 4] *= 1 - dirt;
    px.data[i * 4 + 1] *= 1 - dirt;
    px.data[i * 4 + 2] *= 1 - dirt * 1.05;
  }
  g.putImageData(px, 0, 0);
  // floor plate seams + countersunk screws on the tile border
  g.fillStyle = 'rgba(8,8,9,0.95)';
  g.fillRect(0, 0, S, 3);
  g.fillRect(0, 0, 3, S);
  for (let k = 0; k < 4; k++) {
    screw(g, 14 + k * 128, 14, 5, rand());
    screw(g, 14, 14 + k * 128, 5, rand());
  }
  const rough = roughTex(S, (i) => 0.62 - hh[i] * 0.3 + (f[i] - 0.5) * 0.2);
  return { map: tex(c), normalMap: normalFromHeight(hh, S, S, 5, { topDown: true }), roughnessMap: rough };
}

/**
 * Tub wall (cabin side, floor to sill): blue-grey composite panels 0.5 m wide
 * with recessed seams, fasteners, vent slots and stencils. Tile = 2 m (u) × 1 m (v).
 */
export function wallTextures() {
  const W = 1024;
  const H = 512;
  const rand = mulberry32(23);
  const c = canvas(W, H);
  const g = c.getContext('2d');
  const hc = canvas(W, H);
  const h = hc.getContext('2d');
  g.fillStyle = '#3a4046';
  g.fillRect(0, 0, W, H);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, W, H);
  const pw = 256;
  for (let i = 0; i < 4; i++) {
    const x = i * pw;
    const t = 0.92 + rand() * 0.12;
    g.fillStyle = `rgb(${58 * t | 0},${64 * t | 0},${71 * t | 0})`;
    g.fillRect(x + 4, 4, pw - 8, H - 8);
    // soft panel shading
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, 'rgba(255,255,255,0.05)');
    gr.addColorStop(1, 'rgba(0,0,0,0.18)');
    g.fillStyle = gr;
    g.fillRect(x + 4, 4, pw - 8, H - 8);
    h.fillStyle = '#000';
    h.fillRect(x - 3, 0, 6, H);
    for (const [dx, dy] of [[16, 16], [pw - 16, 16], [16, H - 16], [pw - 16, H - 16], [pw / 2, 16], [pw / 2, H - 16]]) {
      fastener(g, x + dx, dy, 6, rand() * 3);
      h.fillStyle = '#d8d8d8';
      h.beginPath();
      h.arc(x + dx, dy, 6, 0, Math.PI * 2);
      h.fill();
    }
    if (i === 1 || i === 3) {
      // vent slots
      for (let k = 0; k < 9; k++) {
        g.fillStyle = '#121416';
        g.fillRect(x + 70, 150 + k * 22, 116, 9);
        h.fillStyle = '#1a1a1a';
        h.fillRect(x + 70, 150 + k * 22, 116, 9);
      }
    }
  }
  h.fillStyle = '#000';
  h.fillRect(0, 0, W, 5);
  h.fillRect(0, H - 5, W, 5);
  // small part-number stencils (one-off placards live in cabin.js, so they don't repeat every 2 m)
  g.font = `500 15px ${MONO}`;
  g.fillStyle = 'rgba(214,214,206,0.5)';
  g.fillText('P/N 3E-7741-02  S4', 24, 470);
  g.fillText('DO NOT PAINT', 800, 470);
  // kick strip at the bottom
  g.fillStyle = '#26292c';
  g.fillRect(0, H - 60, W, 60);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = 0; i < 160; i++) g.fillRect(rand() * W, H - 60 + rand() * 60, 4 + rand() * 30, 1 + rand() * 3);
  const f = tileableField(256, 6, 3, 24);
  const rough = roughTex(256, (i) => 0.55 + f[i] * 0.2);
  return { map: tex(c), normalMap: normalFromHeight(heights(hc), W, H, 2.5, { topDown: true }), roughnessMap: rough };
}

/** Quilted seat fabric: dark olive Nomex in 6 cm diamonds, stitched. One tile = 0.24 m. */
export function quiltSeatTextures() {
  const S = 256;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const hc = canvas(S, S);
  const h = hc.getContext('2d');
  g.fillStyle = '#2b2e25';
  g.fillRect(0, 0, S, S);
  h.fillStyle = '#000';
  h.fillRect(0, 0, S, S);
  const n = 4;
  const s = S / n;
  for (let j = -1; j <= n; j++) {
    for (let i = -1; i <= n; i++) {
      const cx = i * s + (j % 2 ? s / 2 : 0);
      const cy = j * s * 0.5 + s / 4;
      const gr = h.createRadialGradient(cx, cy, 2, cx, cy, s * 0.55);
      gr.addColorStop(0, '#fff');
      gr.addColorStop(1, '#000');
      h.fillStyle = gr;
      h.beginPath();
      h.moveTo(cx, cy - s * 0.5);
      h.lineTo(cx + s * 0.5, cy);
      h.lineTo(cx, cy + s * 0.5);
      h.lineTo(cx - s * 0.5, cy);
      h.closePath();
      h.fill();
    }
  }
  const hh = heights(hc);
  const px = g.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const k = 0.72 + hh[i] * 0.4;
    px.data[i * 4] *= k;
    px.data[i * 4 + 1] *= k;
    px.data[i * 4 + 2] *= k;
  }
  g.putImageData(px, 0, 0);
  g.strokeStyle = 'rgba(12,13,10,0.85)';
  g.setLineDash([3, 3]);
  g.lineWidth = 1.4;
  for (let k = -S; k < S * 2; k += s) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + S, S);
    g.stroke();
    g.beginPath();
    g.moveTo(k, S);
    g.lineTo(k + S, 0);
    g.stroke();
  }
  return { map: tex(c), normalMap: normalFromHeight(hh, S, S, 3, { topDown: true }) };
}

/**
 * Legend atlas: every switch panel's face (paint, legends, screws, scales) is
 * packed into one canvas, so all panel faces are a single material.
 */
export class Atlas {
  constructor(W = 2048, H = 2048) {
    this.W = W;
    this.H = H;
    this.canvas = canvas(W, H);
    this.g = this.canvas.getContext('2d');
    this.g.fillStyle = '#1f2125';
    this.g.fillRect(0, 0, W, H);
    this.x = 4;
    this.y = 4;
    this.rowH = 0;
    this.jobs = [];
    this.texture = tex(this.canvas, { repeat: false });
  }

  /** Reserve a w×h px rect; `draw(g, rect)` runs now and again once the web fonts land. */
  alloc(w, h, draw) {
    w = Math.ceil(w);
    h = Math.ceil(h);
    if (this.x + w + 4 > this.W) {
      this.x = 4;
      this.y += this.rowH + 6;
      this.rowH = 0;
    }
    const r = { x: this.x, y: this.y, w, h };
    this.x += w + 6;
    this.rowH = Math.max(this.rowH, h);
    if (this.y + h > this.H) console.warn('[cabin] legend atlas full');
    if (draw) {
      this.jobs.push([r, draw]);
      this._run(r, draw);
    }
    return r;
  }

  _run(r, draw) {
    const g = this.g;
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.translate(r.x, r.y);
    draw(g, r.w, r.h);
    g.restore();
  }

  redraw() {
    for (const [r, d] of this.jobs) this._run(r, d);
    this.texture.needsUpdate = true;
  }

  /** (u, v) in 0..1 inside rect (v = 0 at the rect's bottom) → texture uv. */
  uv(r, u, v) {
    return [(r.x + u * r.w) / this.W, 1 - (r.y + (1 - v) * r.h) / this.H];
  }
}
