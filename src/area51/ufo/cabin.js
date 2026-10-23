import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  LatheGeometry,
  LinearFilter,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Batcher, boxProjectUV } from '../hangar/build.js';
import { hazardTexture } from '../../procedural/textures.js';
import { leatherTextures, paintedSteelTextures, twillTextures } from '../textures.js';
import { mulberry32 } from '../../core/math.js';
import { Atlas, deckTextures, FONT, MONO, quiltSeatTextures, screw, treadTextures, wallTextures } from './cabinTextures.js';

/**
 * ARV-3's cabin, built around the pilot (saucer-local, same frame as Cockpit.js):
 *
 *   console  : horseshoe desk on the pilot axis with a knee well under the deck,
 *              a padded leather roll along the edge, Dzus-panelled carcass
 *   panels   : switch panels printed on one legend atlas (toggles, guarded
 *              switches, knobs, a chicken-head selector, keypad, rockers),
 *              a live annunciator strip, four backlit standby gauges, MFD bezels
 *   sides    : side consoles with the drive-spool lever and the strut handle
 *              (both move), circuit-breaker fields, a checklist card
 *   seat     : quilted bucket seat, headrest, rails
 *   shell    : tread-plate floor with a hatch, panelled tub wall with a sill
 *              shelf and LED strip, conduits, avionics rack, O2, extinguisher
 *
 * Everything static is merged per material; the levers, guards and selector are
 * small separate parts animated in update().
 */
const Y = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);
const _q = new Quaternion();
const _e = new Euler();
const FLOOR = 1.78;
const EYE = new Vector3(0, 2.92, 0.3);

// Console cross-section around the pilot axis (r, y), counter-clockwise so the lathe faces out.
const CONSOLE = [
  [1.12, FLOOR], [1.09, 2.2], [1.065, 2.56], [1.05, 2.625], [1.03, 2.652], [1.0, 2.665],
  [0.86, 2.645], [0.6, 2.6], [0.5, 2.585], [0.44, 2.575],
  [0.42, 2.567], [0.402, 2.548], [0.402, 2.528], [0.42, 2.514], [0.45, 2.508],
  [0.62, 2.49], [0.76, 2.47],
  [0.79, 2.445], [0.84, 2.25], [0.9, 2.0], [0.94, FLOOR],
];
const DECK = [[0.44, 2.575], [0.5, 2.585], [0.6, 2.6], [0.86, 2.645], [1.0, 2.665]];
const SPAN = 2.6;
const PHI0 = Math.PI - SPAN / 2;
// Tub around the saucer axis: under the collar → sill shelf + lip → wall → cove → floor edge.
const TUB = [
  [2.8, 2.4], [2.785, 2.352], [2.75, 2.338], [2.68, 2.334], [2.652, 2.322], [2.642, 2.3], [2.638, 2.296],
  [2.625, 2.1], [2.61, 1.93], [2.585, 1.85], [2.54, 1.8], [2.47, 1.782], [2.42, FLOOR],
];

function deckY(r) {
  if (r <= DECK[0][0]) return DECK[0][1];
  for (let i = 1; i < DECK.length; i++) {
    const [r1, y1] = DECK[i];
    const [r0, y0] = DECK[i - 1];
    if (r <= r1) return y0 + ((r - r0) / (r1 - r0)) * (y1 - y0);
  }
  return DECK[DECK.length - 1][1];
}

function deckSlope(r) {
  for (let i = 1; i < DECK.length; i++) if (r <= DECK[i][0]) return (DECK[i][1] - DECK[i - 1][1]) / (DECK[i][0] - DECK[i - 1][0]);
  return 0;
}

/** Lathe with UVs in metres: u around (at radius rRef), v along the profile's arc length. */
function lathe(profile, segs, phi0 = 0, len = Math.PI * 2, { tile = 1, rRef = null, flipU = false, flipV = false } = {}) {
  const [tu, tv] = Array.isArray(tile) ? tile : [tile, tile];
  const pts = profile.map(([r, y]) => new Vector2(r, y));
  const g = new LatheGeometry(pts, segs, phi0, len);
  const n = pts.length;
  const s = [0];
  for (let j = 1; j < n; j++) s.push(s[j - 1] + pts[j].distanceTo(pts[j - 1]));
  const R = rRef ?? Math.max(...profile.map((p) => p[0]));
  const uv = g.attributes.uv;
  for (let k = 0; k < uv.count; k++) {
    const u = ((phi0 + (Math.floor(k / n) / segs) * len) * R) / tu;
    const v = s[k % n] / tv;
    uv.setXY(k, flipU ? -u : u, flipV ? -v : v);
  }
  return g;
}

/** Closing face for a partial lathe at angle phi, facing dir (−1 start, +1 end). */
function latheCap(profile, phi, dir, tile = 0.5) {
  const g = new ShapeGeometry(new Shape(profile.map(([r, y]) => new Vector2(r, y))));
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  const sn = Math.sin(phi);
  const cs = Math.cos(phi);
  for (let i = 0; i < pos.count; i++) {
    const r = pos.getX(i);
    const y = pos.getY(i);
    uv.setXY(i, r / tile, y / tile);
    pos.setXYZ(i, r * sn, y, r * cs);
  }
  const want = new Vector3(cs, 0, -sn).multiplyScalar(dir);
  const idx = g.index.array;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const sum = new Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(pos, idx[t]);
    b.fromBufferAttribute(pos, idx[t + 1]).sub(a);
    c.fromBufferAttribute(pos, idx[t + 2]).sub(a);
    sum.add(b.cross(c));
  }
  if (sum.dot(want) < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const k = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = k;
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Every vertex samples one texel (solid colour from an atlas cell). */
function solidUV(geo, [u, v]) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  return geo;
}

/** Plane (w × d) lying in local XZ facing +Y, its face mapped onto [u0, v0]–[u1, v1]. */
function facePlane(w, d, [u0, v0], [u1, v1]) {
  const g = new PlaneGeometry(w, d);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  g.rotateX(-Math.PI / 2);
  return g;
}

/** A local frame for the batcher (or for a part): boxes, cylinders, spheres placed in it. */
class Frame {
  constructor(b, m = new Matrix4()) {
    this.b = b;
    this.m = m;
  }

  local(p = [0, 0, 0], r = null) {
    _q.setFromEuler(_e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0));
    return new Matrix4().compose(new Vector3(p[0], p[1], p[2]), _q, ONE).premultiply(this.m);
  }

  child(p, r) {
    return new Frame(this.b, this.local(p, r));
  }

  add(geo, mat, p, r) {
    return this.b.add(geo, mat, { matrix: this.local(p, r) });
  }

  box(mat, sx, sy, sz, x, y, z, r, tile = 0.25) {
    const g = new BoxGeometry(sx, sy, sz);
    boxProjectUV(g, tile);
    return this.add(g, mat, [x, y, z], r);
  }

  rbox(mat, sx, sy, sz, x, y, z, rad = 0.004, r, seg = 2) {
    return this.add(new RoundedBoxGeometry(sx, sy, sz, seg, Math.min(rad, sx * 0.49, sy * 0.49, sz * 0.49)), mat, [x, y, z], r);
  }

  cyl(mat, rt, rb, h, x, y, z, r, seg = 16) {
    return this.add(new CylinderGeometry(rt, rb, h, seg), mat, [x, y, z], r);
  }

  sphere(mat, rad, x, y, z, seg = 10) {
    return this.add(new SphereGeometry(rad, seg, Math.max(6, seg >> 1)), mat, [x, y, z]);
  }

  p(v) {
    return new Vector3(v[0], v[1], v[2]).applyMatrix4(this.m);
  }
}

/** A small moving assembly: built like the batch, kept as its own group (pivot at the origin). */
function part(name, build) {
  const pb = new Batcher();
  build(new Frame(pb));
  const g = new Group();
  g.name = name;
  for (const m of pb.build({ name })) g.add(m);
  return g;
}

function place(obj, m) {
  m.decompose(obj.position, obj.quaternion, obj.scale);
  return obj;
}

// ------------------------------------------------------------------ live lights

/** Backlit caps, annunciators and LEDs: one small canvas redrawn when a state changes. */
class Lights {
  constructor() {
    this.W = 512;
    this.H = 512;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.g = this.canvas.getContext('2d');
    this.g.fillStyle = '#050505';
    this.g.fillRect(0, 0, this.W, this.H);
    this.cells = [];
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.anisotropy = 4;
    this.material = new MeshBasicMaterial({ name: 'cab_lights', map: this.texture, color: new Color(1.7, 1.7, 1.7) });
    this._acc = 1;
  }

  /** label (\n for two lines), colour [r,g,b] 0..255, fn(live, t) → 0..1. */
  cell(label, color, fn, round = false) {
    const i = this.cells.length;
    const r = { x: (i % 4) * 128, y: Math.floor(i / 4) * 44, w: 128, h: 44 };
    const c = { label, color, fn, round, r, v: -1 };
    this.cells.push(c);
    return c;
  }

  uv(c, u, v) {
    const { x, y, w, h } = c.r;
    return [(x + 3 + u * (w - 6)) / this.W, 1 - (y + 3 + (1 - v) * (h - 6)) / this.H];
  }

  update(dt, t, live) {
    this._acc += dt;
    if (this._acc < 0.1) return;
    this._acc = 0;
    let dirty = false;
    for (const c of this.cells) {
      const v = Math.round(Math.max(0, Math.min(1, c.fn(live, t))) * 16) / 16;
      if (v === c.v) continue;
      c.v = v;
      this._draw(c);
      dirty = true;
    }
    if (dirty) this.texture.needsUpdate = true;
  }

  redraw() {
    for (const c of this.cells) this._draw(c);
    this.texture.needsUpdate = true;
  }

  _draw(c) {
    const g = this.g;
    const { x, y, w, h } = c.r;
    const on = Math.max(0, c.v);
    const [r, gg, b] = c.color;
    g.fillStyle = '#040404';
    g.fillRect(x, y, w, h);
    if (c.round) {
      const gr = g.createRadialGradient(x + w / 2, y + h / 2, 1, x + w / 2, y + h / 2, h * 0.7);
      gr.addColorStop(0, `rgb(${(30 + r * on) | 0},${(30 + gg * on) | 0},${(30 + b * on) | 0})`);
      gr.addColorStop(1, `rgb(${(14 + r * on * 0.5) | 0},${(14 + gg * on * 0.5) | 0},${(14 + b * on * 0.5) | 0})`);
      g.fillStyle = gr;
      g.fillRect(x, y, w, h);
      return;
    }
    g.fillStyle = `rgb(${(16 + r * on * 0.22) | 0},${(17 + gg * on * 0.22) | 0},${(18 + b * on * 0.22) | 0})`;
    g.fillRect(x + 3, y + 3, w - 6, h - 6);
    const lines = c.label.split('\n');
    g.font = `700 ${lines.length > 1 ? 15 : 19}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = on > 0.05 ? `rgb(${Math.min(255, r * (0.55 + 0.45 * on) + 40 * on) | 0},${Math.min(255, gg * (0.55 + 0.45 * on) + 40 * on) | 0},${Math.min(255, b * (0.55 + 0.45 * on) + 40 * on) | 0})` : '#34363a';
    lines.forEach((s, k) => g.fillText(s, x + w / 2, y + h / 2 + (k - (lines.length - 1) / 2) * 16));
  }
}

// ------------------------------------------------------------------ standby gauges

/** Four backlit standby instruments on one canvas (ATT, ALT, FIELD, V/S), 12 fps. */
class Gauges {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 256;
    this.g = this.canvas.getContext('2d');
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.anisotropy = 4;
    this._acc = 1;
  }

  uv(i, u, v) {
    return [(i + u) / 4, v];
  }

  update(dt, t, L) {
    this._acc += dt;
    if (this._acc < 1 / 12) return;
    this._acc = 0;
    const g = this.g;
    const lit = 0.25 + 0.75 * Math.min(1, (L.power ?? 0) * 3);
    for (let i = 0; i < 4; i++) {
      g.save();
      g.translate(i * 256 + 128, 128);
      this._dial(g, i, L, lit);
      g.restore();
    }
    this.texture.needsUpdate = true;
  }

  _dial(g, i, L, lit) {
    const R = 120;
    g.fillStyle = '#0a0b0c';
    g.fillRect(-128, -128, 256, 256);
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fillStyle = '#101214';
    g.fill();
    const white = `rgba(232,236,230,${0.35 + 0.65 * lit})`;
    const ticks = (a0, a1, n, len, w) => {
      g.strokeStyle = white;
      g.lineWidth = w;
      for (let k = 0; k <= n; k++) {
        const a = a0 + ((a1 - a0) * k) / n - Math.PI / 2;
        g.beginPath();
        g.moveTo(Math.cos(a) * (R - 6), Math.sin(a) * (R - 6));
        g.lineTo(Math.cos(a) * (R - 6 - len), Math.sin(a) * (R - 6 - len));
        g.stroke();
      }
    };
    const needle = (a, len, w, col = white) => {
      g.save();
      g.rotate(a);
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(-w, 14);
      g.lineTo(-w * 0.45, -len);
      g.lineTo(0, -len - 8);
      g.lineTo(w * 0.45, -len);
      g.lineTo(w, 14);
      g.closePath();
      g.fill();
      g.restore();
    };
    const label = (s, y, size = 20) => {
      g.fillStyle = white;
      g.font = `600 ${size}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s, 0, y);
    };
    if (i === 0) {
      // attitude
      g.save();
      g.beginPath();
      g.arc(0, 0, R - 4, 0, Math.PI * 2);
      g.clip();
      g.rotate(-((L.bank ?? 0) * Math.PI) / 180);
      const off = Math.max(-90, Math.min(90, (L.pitch ?? 0) * 2.4));
      g.fillStyle = `rgb(${(30 * lit + 10) | 0},${(80 * lit + 14) | 0},${(120 * lit + 18) | 0})`;
      g.fillRect(-R * 2, -R * 2 + off, R * 4, R * 2);
      g.fillStyle = `rgb(${(80 * lit + 12) | 0},${(54 * lit + 10) | 0},${(30 * lit + 8) | 0})`;
      g.fillRect(-R * 2, off, R * 4, R * 2);
      g.strokeStyle = white;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(-R * 2, off);
      g.lineTo(R * 2, off);
      g.stroke();
      g.lineWidth = 2;
      for (let p = -30; p <= 30; p += 10) {
        if (!p) continue;
        const y = off - p * 2.4;
        const w = p % 20 ? 18 : 32;
        g.beginPath();
        g.moveTo(-w, y);
        g.lineTo(w, y);
        g.stroke();
      }
      g.restore();
      ticks(-Math.PI / 3, Math.PI / 3, 6, 12, 3);
      g.strokeStyle = `rgba(255,150,40,${0.5 + 0.5 * lit})`;
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(-58, 4);
      g.lineTo(-20, 4);
      g.lineTo(-10, 16);
      g.moveTo(58, 4);
      g.lineTo(20, 4);
      g.lineTo(10, 16);
      g.stroke();
      g.fillStyle = `rgba(255,150,40,${0.5 + 0.5 * lit})`;
      g.fillRect(-4, -2, 8, 8);
    } else if (i === 1) {
      // altimeter: long needle 100 m/div (1 km per turn), short needle km (10 km per turn)
      ticks(0, Math.PI * 2 * 0.98, 49, 8, 2);
      ticks(0, Math.PI * 2 * 0.9, 9, 18, 4);
      g.font = `600 26px ${FONT}`;
      g.fillStyle = white;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
        g.fillText(String(k), Math.cos(a) * (R - 40), Math.sin(a) * (R - 40));
      }
      label('ALT', -30, 16);
      label('km', 34, 15);
      const alt = Math.max(0, L.alt ?? 0);
      needle(((alt % 10000) / 10000) * Math.PI * 2, 58, 9);
      needle(((alt % 1000) / 1000) * Math.PI * 2, 96, 5);
    } else if (i === 2) {
      // gravity field strength
      const a0 = -Math.PI * 0.75;
      const a1 = Math.PI * 0.75;
      const arc = (f0, f1, col, w) => {
        g.strokeStyle = col;
        g.lineWidth = w;
        g.beginPath();
        g.arc(0, 0, R - 16, a0 + (a1 - a0) * f0 - Math.PI / 2, a0 + (a1 - a0) * f1 - Math.PI / 2);
        g.stroke();
      };
      arc(0.2, 0.88, `rgba(90,200,120,${0.4 + 0.6 * lit})`, 8);
      arc(0.92, 1, `rgba(230,60,40,${0.4 + 0.6 * lit})`, 8);
      ticks(a0, a1, 10, 14, 3);
      g.font = `600 22px ${FONT}`;
      g.fillStyle = white;
      for (let k = 0; k <= 10; k += 2) {
        const a = a0 + ((a1 - a0) * k) / 10 - Math.PI / 2;
        g.fillText(String(k * 10), Math.cos(a) * (R - 46), Math.sin(a) * (R - 46));
      }
      label('FIELD', 40, 17);
      label('%', 64, 15);
      const f = (L.power ?? 0) * (0.55 + 0.45 * (L.thrust ?? 0)) + (L.overdrive ? 0.06 : 0);
      needle(a0 + (a1 - a0) * Math.min(1.02, f), 92, 6, `rgba(255,170,60,${0.6 + 0.4 * lit})`);
    } else {
      // vertical speed ±30 m/s, zero at 9 o'clock
      const a0 = -Math.PI * 0.95;
      const a1 = -Math.PI * 0.05;
      ticks(a0, a1, 12, 12, 3);
      ticks(Math.PI * 0.05, Math.PI * 0.95, 12, 12, 3);
      g.font = `600 22px ${FONT}`;
      g.fillStyle = white;
      for (const [v, a] of [[0, -Math.PI / 2], [10, -Math.PI / 6], [20, Math.PI / 6], [30, Math.PI / 2], [10, -Math.PI * 5 / 6], [20, Math.PI * 7 / 6]]) {
        g.fillText(String(v), Math.cos(a - Math.PI / 2) * (R - 40), Math.sin(a - Math.PI / 2) * (R - 40));
      }
      label('V/S', -34, 16);
      label('m/s', 34, 15);
      const vs = Math.max(-30, Math.min(30, L.vs ?? 0));
      needle(-Math.PI / 2 + (vs / 30) * Math.PI * 0.9, 96, 6);
    }
    g.beginPath();
    g.arc(0, 0, 11, 0, Math.PI * 2);
    g.fillStyle = '#2a2c2f';
    g.fill();
    // glass vignette
    const gr = g.createRadialGradient(0, 0, R * 0.6, 0, 0, R);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fill();
  }
}

// ------------------------------------------------------------------ panel printing

function text(g, s, x, y, px, { align = 'center', color = '#d9ddd6', weight = 600, font = FONT, base = 'middle' } = {}) {
  g.font = `${weight} ${px}px ${font}`;
  g.textAlign = align;
  g.textBaseline = base;
  g.fillStyle = color;
  g.fillText(s, x, y);
}

/** Draws a panel face (paint, border, screws, every item's legend) in panel metres. */
function printPanel(spec, rand) {
  const seed = rand();
  return (g, W, H) => {
    const k = W / spec.w;
    const X = (x) => (x + spec.w / 2) * k;
    const Z = (z) => (z + spec.d / 2) * k;
    const r2 = mulberry32((seed * 1e9) | 0);
    g.fillStyle = spec.bg || '#2b2e33';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(${r2() < 0.5 ? '200,200,205' : '0,0,0'},${0.02 + r2() * 0.04})`;
      g.fillRect(r2() * W, r2() * H, 2 + r2() * 26, 1 + r2() * 2);
    }
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = Math.max(2, 0.0012 * k);
    g.strokeRect(1, 1, W - 2, H - 2);
    g.strokeStyle = 'rgba(160,165,170,0.16)';
    g.strokeRect(0.003 * k, 0.003 * k, W - 0.006 * k, H - 0.006 * k);
    const sr = 0.0026 * k;
    for (const [sx, sy] of [[0.0065, 0.0065], [spec.w - 0.0065, 0.0065], [0.0065, spec.d - 0.0065], [spec.w - 0.0065, spec.d - 0.0065]]) screw(g, sx * k, sy * k, sr, r2() * 3);
    const L = (s, x, z, size = 0.0055, o = {}) => text(g, s, X(x), Z(z), size * k, o);
    if (spec.title) {
      L(spec.title, 0, -spec.d / 2 + 0.011, 0.0062, { weight: 700 });
      g.fillStyle = 'rgba(217,221,214,0.5)';
      g.fillRect(X(-spec.w / 2 + 0.012), Z(-spec.d / 2 + 0.0185), (spec.w - 0.024) * k, Math.max(1, 0.0006 * k));
    }
    for (const it of spec.items) {
      const { x, z } = it;
      switch (it.t) {
        case 'toggle':
        case 'guard':
          if (it.label) L(it.label, x, z - 0.0185, 0.0048);
          L(it.off ?? 'OFF', x, z + 0.0155, 0.0036, { color: 'rgba(217,221,214,0.65)' });
          if (it.t === 'guard') {
            g.strokeStyle = it.color === 'red' ? 'rgba(200,40,30,0.95)' : 'rgba(214,165,20,0.95)';
            g.lineWidth = 0.0013 * k;
            g.strokeRect(X(x - 0.016), Z(z - 0.026), 0.032 * k, 0.052 * k);
          }
          break;
        case 'knob': {
          const R = (it.r ?? 0.011) + 0.0055;
          g.strokeStyle = 'rgba(217,221,214,0.8)';
          g.lineWidth = 0.0007 * k;
          const n = it.ticks ?? 11;
          for (let i = 0; i < n; i++) {
            const a = -Math.PI * 0.75 + (i / (n - 1)) * Math.PI * 1.5 - Math.PI / 2;
            const l = i % 5 === 0 ? 0.0035 : 0.002;
            g.beginPath();
            g.moveTo(X(x) + Math.cos(a) * R * k, Z(z) + Math.sin(a) * R * k);
            g.lineTo(X(x) + Math.cos(a) * (R + l) * k, Z(z) + Math.sin(a) * (R + l) * k);
            g.stroke();
          }
          if (it.label) L(it.label, x, z + R + 0.0075, 0.0046);
          break;
        }
        case 'selector': {
          const R = 0.021;
          it.pos.forEach((s, i) => {
            const a = it.angles[i] - Math.PI / 2;
            L(s, x + Math.cos(a) * R, z + Math.sin(a) * R, 0.0038);
          });
          if (it.label) L(it.label, x, z + 0.027, 0.0048);
          break;
        }
        case 'rocker':
          if (it.label) L(it.label, x, z - 0.019, 0.0042);
          break;
        case 'breaker':
          L(it.label, x, z + 0.0095, 0.003, { weight: 500 });
          L(String(it.amps ?? 5), x, z - 0.0085, 0.0028, { weight: 500, color: 'rgba(217,221,214,0.6)' });
          break;
        case 'text':
          L(it.text, x, z, it.size ?? 0.005, { align: it.align ?? 'center', weight: it.weight ?? 600, color: it.color, font: it.mono ? MONO : FONT });
          break;
        case 'frame': {
          g.strokeStyle = 'rgba(217,221,214,0.45)';
          g.lineWidth = Math.max(1, 0.0006 * k);
          g.strokeRect(X(x - it.w / 2), Z(z - it.d / 2), it.w * k, it.d * k);
          if (it.label) {
            g.font = `700 ${0.0038 * k}px ${FONT}`;
            const tw = g.measureText(it.label).width + 0.003 * k;
            g.fillStyle = spec.bg || '#2b2e33';
            g.fillRect(X(x) - tw / 2, Z(z - it.d / 2) - 0.003 * k, tw, 0.006 * k);
            L(it.label, x, z - it.d / 2, 0.0038, { weight: 700, color: 'rgba(217,221,214,0.8)' });
          }
          break;
        }
        case 'slot':
          g.fillStyle = '#060607';
          g.beginPath();
          g.roundRect(X(x - it.w / 2), Z(z - it.d / 2), it.w * k, it.d * k, (it.w * k) / 2);
          g.fill();
          (it.marks || []).forEach(([s, mz]) => {
            g.fillStyle = 'rgba(217,221,214,0.85)';
            g.fillRect(X(x + it.w / 2 + 0.003), Z(mz) - 0.0004 * k, 0.006 * k, 0.0008 * k);
            L(s, x + it.w / 2 + 0.0105, mz, 0.0042, { align: 'left' });
          });
          break;
        case 'stripe': {
          g.save();
          g.beginPath();
          g.rect(X(x - it.w / 2), Z(z - it.d / 2), it.w * k, it.d * k);
          g.clip();
          g.fillStyle = '#d4a017';
          g.fillRect(X(x - it.w / 2), Z(z - it.d / 2), it.w * k, it.d * k);
          g.fillStyle = '#111';
          const st = 0.008 * k;
          for (let s = -it.d * k; s < it.w * k + it.d * k; s += st * 2) {
            g.beginPath();
            g.moveTo(X(x - it.w / 2) + s, Z(z + it.d / 2));
            g.lineTo(X(x - it.w / 2) + s + st, Z(z + it.d / 2));
            g.lineTo(X(x - it.w / 2) + s + st + it.d * k, Z(z - it.d / 2));
            g.lineTo(X(x - it.w / 2) + s + it.d * k, Z(z - it.d / 2));
            g.closePath();
            g.fill();
          }
          g.restore();
          break;
        }
        default:
          if (it.label && it.t === 'lit') L(it.label, x, z - (it.d ?? 0.02) / 2 - 0.006, 0.004);
      }
    }
    if (spec.draw) spec.draw(g, X, Z, k);
  };
}

// ------------------------------------------------------------------ the build

export function buildCabin(cockpit, { PILOT, PAD }) {
  const P = PILOT;
  const rand = mulberry32(306);
  const b = new Batcher(); // near the pilot: casts into the cabin sun's shadow map
  const nb = new Batcher(); // shell + far equipment: receives only
  const atlas = new Atlas(2048, 2048);
  const caps = new Atlas(1024, 512);
  const lights = new Lights();
  const gauges = new Gauges();
  const mats = [];
  const std = (o) => {
    const m = new MeshStandardMaterial(o);
    mats.push(m);
    return m;
  };
  const steel = paintedSteelTextures();
  const leather = leatherTextures();
  const twill = twillTextures();
  const deck = deckTextures();
  const tread = treadTextures();
  const wall = wallTextures();
  const quilt = quiltSeatTextures();
  const M = {
    deck: std({ name: 'cab_deck', map: deck.map, normalMap: deck.normalMap, roughnessMap: deck.roughnessMap, normalScale: new Vector2(0.8, 0.8), roughness: 1, metalness: 0.35, envMapIntensity: 0.6 }),
    carcass: std({ name: 'cab_carcass', color: 0x2a2d31, roughness: 0.58, metalness: 0.4, normalMap: steel.normalMap, roughnessMap: steel.roughnessMap, normalScale: new Vector2(0.35, 0.35), envMapIntensity: 0.6 }),
    panelEdge: std({ name: 'cab_panel_edge', color: 0x1d1f23, roughness: 0.45, metalness: 0.5 }),
    panel: std({ name: 'cab_panel', map: atlas.texture, roughness: 0.62, metalness: 0.15, envMapIntensity: 0.5 }),
    caps: std({ name: 'cab_caps', map: caps.texture, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.5 }),
    black: std({ name: 'cab_black', color: 0x111214, roughness: 0.4, metalness: 0.15 }),
    rubber: std({ name: 'cab_rubber', color: 0x141414, roughness: 0.88, metalness: 0 }),
    alu: std({ name: 'cab_alu', color: 0x9da2a7, roughness: 0.3, metalness: 1 }),
    chrome: std({ name: 'cab_chrome', color: 0xdcdee0, roughness: 0.12, metalness: 1 }),
    white: std({ name: 'cab_white', color: 0xe8e8e2, roughness: 0.5, metalness: 0 }),
    red: std({ name: 'cab_red', color: 0xa8150e, roughness: 0.32, metalness: 0.1 }),
    hazard: std({ name: 'cab_hazard', map: hazardTexture(), roughness: 0.42, metalness: 0.1 }),
    brass: std({ name: 'cab_brass', color: 0xb8924c, roughness: 0.28, metalness: 1 }),
    leather: std({ name: 'cab_leather', color: 0x1c1a19, roughness: 0.7, normalMap: leather.normalMap, roughnessMap: leather.roughnessMap, normalScale: new Vector2(0.6, 0.6) }),
    cushion: std({ name: 'cab_cushion', map: quilt.map, normalMap: quilt.normalMap, roughness: 0.92, metalness: 0 }),
    webbing: std({ name: 'cab_webbing', color: 0x434633, roughness: 0.9, normalMap: twill.normalMap, normalScale: new Vector2(0.8, 0.8) }),
    wall: std({ name: 'cab_wall', map: wall.map, normalMap: wall.normalMap, roughnessMap: wall.roughnessMap, roughness: 1, metalness: 0.3, envMapIntensity: 0.5 }),
    floor: std({ name: 'cab_floor', map: tread.map, normalMap: tread.normalMap, roughnessMap: tread.roughnessMap, roughness: 1, metalness: 0.75, envMapIntensity: 0.55 }),
    cable: std({ name: 'cab_cable', color: 0x131415, roughness: 0.55, metalness: 0 }),
    cableOrange: std({ name: 'cab_cable_or', color: 0xb0501c, roughness: 0.5, metalness: 0 }),
    o2: std({ name: 'cab_o2', color: 0x2e5a34, roughness: 0.42, metalness: 0.3 }),
    ext: std({ name: 'cab_ext', color: 0xb31d15, roughness: 0.3, metalness: 0.2 }),
    olive: std({ name: 'cab_olive', color: 0x3b4031, roughness: 0.75, metalness: 0.1, normalMap: steel.normalMap, normalScale: new Vector2(0.3, 0.3) }),
    gauge: std({ name: 'cab_gauge', map: gauges.texture, emissiveMap: gauges.texture, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.6, metalness: 0 }),
    glass: std({ name: 'cab_glass', color: 0x000000, roughness: 0.06, metalness: 0, transparent: true, blending: AdditiveBlending, depthWrite: false, envMapIntensity: 0.9 }),
    lights: lights.material,
    led: new MeshBasicMaterial({ name: 'cab_led_strip', color: new Color(1.25, 1.3, 1.4) }),
  };
  const R = new Frame(b);
  const N = new Frame(nb);
  const polar = (a, r) => new Vector3(P.x - Math.sin(a) * r, 0, P.z - Math.cos(a) * r); // a > 0 = left of straight ahead

  /** Frame on the deck at (a, r): x = pilot's right, y = surface normal, z = toward the pilot. */
  const deckFrame = (a, r, lift = 0) => {
    const az = Math.PI + a;
    const f = new Vector3(Math.sin(az), 0, Math.cos(az));
    const right = new Vector3().crossVectors(f, Y);
    const s = Math.atan(deckSlope(r));
    const n = Y.clone().multiplyScalar(Math.cos(s)).addScaledVector(f, -Math.sin(s));
    const z = new Vector3().crossVectors(right, n);
    const m = new Matrix4().makeBasis(right, n, z);
    const p = polar(a, r);
    m.setPosition(p.x, deckY(r) + lift, p.z);
    return new Frame(b, m);
  };

  /** Frame against the tub wall at saucer azimuth phi: z toward the cabin centre. */
  const wallFrame = (phi, r, y = FLOOR, bat = nb) => {
    const out = new Vector3(Math.sin(phi), 0, Math.cos(phi));
    const z = out.clone().negate();
    const x = new Vector3().crossVectors(Y, z);
    return new Frame(bat, new Matrix4().makeBasis(x, Y, z).setPosition(out.x * r, y, out.z * r));
  };

  // ---------------------------------------------------------------- shell

  N.add(lathe(TUB, 160, 0, Math.PI * 2, { tile: [2, 1], rRef: 2.62, flipU: true, flipV: true }), M.wall);
  {
    const g = new CircleGeometry(2.43, 120);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 0.4, -pos.getZ(i) / 0.4);
    N.add(g, M.floor, [0, FLOOR, 0]);
  }
  // LED strip under the sill lip, conduits round the wall base, clamps
  N.add(lathe([[2.643, 2.293], [2.632, 2.287], [2.636, 2.281], [2.647, 2.287], [2.643, 2.293]], 160), M.led);
  for (const [r, y, rad, mat] of [[2.575, 1.865, 0.022, M.cable], [2.58, 1.915, 0.016, M.cableOrange], [2.585, 1.958, 0.02, M.alu]]) {
    const ring = [];
    for (let k = 0; k <= 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      ring.push([r + Math.cos(a) * rad, y + Math.sin(a) * rad]);
    }
    N.add(lathe(ring, 140), mat);
  }
  for (let k = 0; k < 28; k++) {
    const phi = (k / 28) * Math.PI * 2 + 0.05;
    wallFrame(phi, 2.58).box(M.panelEdge, 0.035, 0.13, 0.05, 0, 1.912 - FLOOR, 0.0);
  }
  // sill grab handles at the sides
  for (const phi of [Math.PI / 2 + 0.35, -Math.PI / 2 - 0.35, 0.55, -0.55]) {
    const F = wallFrame(phi, 2.7, 2.334);
    F.cyl(M.alu, 0.012, 0.012, 0.36, 0, 0.055, 0.02, [0, 0, Math.PI / 2], 12);
    for (const s of [-1, 1]) F.cyl(M.alu, 0.01, 0.01, 0.055, s * 0.16, 0.027, 0.02, null, 10);
  }

  // ---------------------------------------------------------------- console

  const conGeo = lathe(CONSOLE, 72, PHI0, SPAN, { tile: 0.5, rRef: 0.75 });
  R.add(conGeo, M.deck, [P.x, 0, P.z]);
  R.add(latheCap(CONSOLE, PHI0, -1), M.carcass, [P.x, 0, P.z]);
  R.add(latheCap(CONSOLE, PHI0 + SPAN, 1), M.carcass, [P.x, 0, P.z]);
  // padded leather roll along the edge (wrists rest on it), closed with domes
  {
    const ring = [];
    for (let k = 0; k <= 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      ring.push([0.398 + Math.cos(a) * 0.024, 2.552 + Math.sin(a) * 0.024]);
    }
    R.add(lathe(ring, 96, PHI0, SPAN, { tile: 0.12, rRef: 0.4 }), M.leather, [P.x, 0, P.z]);
    for (const a of [SPAN / 2, -SPAN / 2]) {
      const p = polar(a, 0.398);
      R.sphere(M.leather, 0.024, p.x, 2.552, p.z, 14);
    }
  }
  // toe rail under the knee panel
  {
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const a = -0.42 + (k / 12) * 0.84;
      const p = polar(a, 0.74);
      pts.push(new Vector3(p.x, 1.86, p.z));
    }
    R.add(new TubeGeometry(new CatmullRomCurve3(pts), 24, 0.012, 8), M.alu);
    for (const a of [-0.42, 0.42]) {
      const p = polar(a, 0.79);
      R.cyl(M.alu, 0.01, 0.01, 0.1, p.x, 1.84, p.z, [Math.PI / 2, 0, -a], 8);
    }
  }
  // knee-panel vents and a map case
  for (const a of [-0.55, 0.55]) {
    const az = Math.PI + a;
    const p = polar(a, 0.865);
    const F = new Frame(b, new Matrix4().makeRotationY(az + Math.PI).setPosition(p.x, 2.13, p.z)).child([0, 0, 0], [0.24, 0, 0]);
    F.rbox(M.black, 0.16, 0.09, 0.012, 0, 0, 0.004, 0.004);
    for (let k = 0; k < 6; k++) F.box(M.panelEdge, 0.14, 0.004, 0.006, 0, -0.03 + k * 0.012, 0.012);
  }

  // ---------------------------------------------------------------- panels

  const animated = [];
  /**
   * A switch panel on frame F: dark slab + printed face + the 3D switchgear. Items:
   * toggle / guard / knob / selector / cap / lit / rocker / breaker / led / text / frame / slot / stripe.
   */
  const panel = (F, spec) => {
    const ppm = spec.ppm ?? 2200;
    const rect = atlas.alloc(spec.w * ppm, spec.d * ppm, printPanel(spec, rand));
    F.rbox(M.panelEdge, spec.w, 0.006, spec.d, 0, 0.003, 0, 0.0022);
    F.add(facePlane(spec.w * 0.995, spec.d * 0.995, atlas.uv(rect, 0, 0), atlas.uv(rect, 1, 1)), M.panel, [0, 0.0062, 0]);
    const y0 = 0.0062;
    for (const it of spec.items) {
      const { x, z } = it;
      switch (it.t) {
        case 'toggle':
          toggleGeo(F, x, z, it.up ?? true, y0);
          break;
        case 'guard': {
          toggleGeo(F, x, z, it.up ?? false, y0);
          F.box(M.black, 0.026, 0.002, 0.046, x, y0 + 0.001, z - 0.002);
          const hinge = [x, y0 + 0.0145, z - 0.02];
          const g = part(`guard_${it.id || 'x'}`, (Q) => {
            const mat = it.color === 'red' ? M.red : M.hazard;
            for (const s of [-1, 1]) Q.box(mat, 0.0016, 0.0135, 0.038, s * 0.0108, -0.0068, 0.019, null, 0.02);
            Q.box(mat, 0.0232, 0.0016, 0.038, 0, 0, 0.019, null, 0.02);
            Q.cyl(M.alu, 0.0022, 0.0022, 0.026, 0, 0, 0, [0, 0, Math.PI / 2], 8);
          });
          place(g, F.local(hinge));
          const pivot = new Group();
          pivot.add(...g.children);
          g.add(pivot);
          animated.push({ kind: 'guard', id: it.id, obj: pivot, v: 0 });
          extra.push(g);
          break;
        }
        case 'knob': {
          const r = it.r ?? 0.011;
          F.cyl(M.black, r + 0.0035, r + 0.0035, 0.0018, x, y0 + 0.0009, z, null, 28);
          F.cyl(M.black, r * 0.9, r, 0.014, x, y0 + 0.0088, z, null, 28);
          F.cyl(M.alu, r * 0.78, r * 0.84, 0.0016, x, y0 + 0.0163, z, null, 24);
          const a = it.at ?? (rand() - 0.5) * 2.2;
          F.box(M.white, 0.0013, 0.0008, r * 0.7, x + Math.sin(a) * r * 0.42, y0 + 0.0174, z - Math.cos(a) * r * 0.42, [0, -a, 0]);
          break;
        }
        case 'selector': {
          F.cyl(M.black, 0.013, 0.013, 0.002, x, y0 + 0.001, z, null, 24);
          const g = part(`sel_${it.id || 'x'}`, (Q) => {
            Q.cyl(M.black, 0.0085, 0.0095, 0.012, 0, 0.006, 0, null, 18);
            Q.rbox(M.black, 0.0085, 0.013, 0.036, 0, 0.0115, 0, 0.003);
            Q.box(M.white, 0.0016, 0.001, 0.016, 0, 0.0182, -0.009);
          });
          place(g, F.local([x, y0 + 0.002, z]));
          const pivot = new Group();
          pivot.add(...g.children);
          g.add(pivot);
          animated.push({ kind: 'selector', id: it.id, obj: pivot, angles: it.angles, v: 0 });
          extra.push(g);
          break;
        }
        case 'cap': {
          const w = it.w ?? 0.02;
          const d = it.d ?? 0.016;
          const h = it.h ?? 0.006;
          F.rbox(M.black, w, h, d, x, y0 + h / 2, z, 0.0018);
          const r = caps.alloc(w * 3600, d * 3600, (g, W, H) => {
            g.fillStyle = '#15161a';
            g.fillRect(0, 0, W, H);
            text(g, it.label, W / 2, H / 2 + 1, H * (it.label.length > 3 ? 0.36 : 0.5), { weight: 700, color: it.color || '#dfe2dc' });
          });
          F.add(facePlane(w * 0.84, d * 0.84, caps.uv(r, 0, 0), caps.uv(r, 1, 1)), M.caps, [x, y0 + h + 0.0002, z]);
          break;
        }
        case 'lit': {
          const w = it.w ?? 0.034;
          const d = it.d ?? 0.02;
          const h = it.h ?? 0.006;
          F.rbox(M.black, w + 0.004, h, d + 0.004, x, y0 + h / 2, z, 0.0018);
          F.add(facePlane(w, d, lights.uv(it.cell, 0, 0), lights.uv(it.cell, 1, 1)), M.lights, [x, y0 + h + 0.0002, z]);
          break;
        }
        case 'led': {
          F.cyl(M.chrome, 0.0042, 0.0042, 0.003, x, y0 + 0.0015, z, null, 14);
          F.add(solidUV(new SphereGeometry(0.0028, 12, 8), lights.uv(it.cell, 0.5, 0.5)), M.lights, [x, y0 + 0.003, z]);
          break;
        }
        case 'rocker': {
          F.rbox(M.panelEdge, 0.015, 0.004, 0.026, x, y0 + 0.002, z, 0.0015);
          F.rbox(M.black, 0.0115, 0.007, 0.022, x, y0 + 0.006, z, 0.0025, [it.up === false ? 0.13 : -0.13, 0, 0]);
          F.box(M.white, 0.006, 0.0006, 0.0012, x, y0 + 0.0097, z - 0.006);
          break;
        }
        case 'breaker': {
          const popped = it.popped ? 0.004 : 0;
          F.cyl(M.panelEdge, 0.0058, 0.0058, 0.002, x, y0 + 0.001, z, null, 6);
          F.cyl(M.black, 0.0042, 0.0045, 0.009 + popped, x, y0 + 0.0045 + popped / 2, z, null, 12);
          if (popped) F.cyl(M.white, 0.0046, 0.0046, 0.0035, x, y0 + 0.0035, z, null, 12);
          break;
        }
        default:
          break;
      }
    }
  };

  const toggleGeo = (F, x, z, up, y0) => {
    F.cyl(M.alu, 0.0064, 0.0064, 0.0026, x, y0 + 0.0013, z, null, 6);
    F.cyl(M.chrome, 0.0037, 0.0037, 0.0062, x, y0 + 0.0057, z, null, 12);
    const a = up ? -0.36 : 0.36;
    const L = 0.021;
    const y1 = y0 + 0.0085;
    F.cyl(M.chrome, 0.0014, 0.0023, L, x, y1 + (Math.cos(a) * L) / 2, z + (Math.sin(a) * L) / 2, [a, 0, 0], 10);
    F.sphere(M.chrome, 0.0027, x, y1 + Math.cos(a) * L, z + Math.sin(a) * L, 10);
  };

  const extra = [];
  const AMBER = [255, 170, 40];
  const GREEN = [90, 230, 120];
  const RED = [255, 60, 40];
  const WHITE = [220, 230, 240];
  const CYAN = [80, 210, 255];
  const blink = (t, hz = 1.6) => (Math.sin(t * Math.PI * 2 * hz) > 0 ? 1 : 0.15);
  const pw = (L) => L.power ?? 0;
  const spooling = (L, t) => (pw(L) > 0.02 && pw(L) < 0.985 ? blink(t, 1.2) : 0);

  // Centre strip between the pads: arm / overdrive guards, field selector, four lit caps.
  const cSpool = lights.cell('SPOOL', AMBER, (L, t) => spooling(L, t));
  const cField = lights.cell('FIELD', GREEN, (L) => (pw(L) > 0.985 ? 1 : 0));
  const cWarp = lights.cell('WARP', CYAN, (L, t) => (L.warp === 'spool' ? blink(t, 3) : L.warp === 'jump' ? 1 : 0));
  const cOD = lights.cell('O-DRV', WHITE, (L) => (L.overdrive ? 1 : 0));
  panel(deckFrame(0, 0.615), ({
    w: 0.2,
    d: 0.27,
    title: 'GRAVITIC DRIVE',
    items: [
      { t: 'guard', x: -0.048, z: -0.07, label: 'DRIVE ARM', color: 'red', id: 'arm' },
      { t: 'guard', x: 0.048, z: -0.07, label: 'OVERDRIVE', color: 'hazard', id: 'od' },
      { t: 'selector', x: 0, z: 0.005, label: 'FIELD MODE', id: 'field', pos: ['OFF', 'STBY', 'TRIM', 'MAX'], angles: [-1.0, -0.33, 0.33, 1.0] },
      { t: 'lit', x: -0.0705, z: 0.078, w: 0.036, d: 0.021, cell: cSpool },
      { t: 'lit', x: -0.0235, z: 0.078, w: 0.036, d: 0.021, cell: cField },
      { t: 'lit', x: 0.0235, z: 0.078, w: 0.036, d: 0.021, cell: cWarp },
      { t: 'lit', x: 0.0705, z: 0.078, w: 0.036, d: 0.021, cell: cOD },
      { t: 'text', x: 0, z: 0.118, text: 'ARV-3 · S4 · DO NOT ENGAGE INSIDE HANGAR', size: 0.0034, weight: 500, color: 'rgba(217,221,214,0.6)' },
    ],
  }));

  // Annunciator strip on a wedge in front of the centre screen.
  {
    const cells = [
      lights.cell('MASTER\nCAUTION', AMBER, (L, t) => (L.warn ? blink(t, 2) : 0)),
      lights.cell('GRAV\nFIELD', GREEN, (L) => (pw(L) > 0.5 ? 1 : 0)),
      lights.cell('BUS A', GREEN, (L) => (pw(L) > 0.02 ? 1 : 0)),
      lights.cell('BUS B', GREEN, (L) => (pw(L) > 0.1 ? 1 : 0)),
      lights.cell('STRUTS', AMBER, (L, t) => ((L.strut ?? 1) > 0.02 && (L.strut ?? 1) < 0.98 ? blink(t, 1.4) : 0)),
      lights.cell('RAMP\nOPEN', RED, (L) => ((L.ramp ?? 0) > 0.02 ? 1 : 0)),
      lights.cell('HULL\nTEMP', AMBER, (L) => ((L.speed ?? 0) > 1800 ? 1 : 0)),
      lights.cell('NAV', GREEN, (L) => (pw(L) > 0.3 ? 1 : 0)),
      lights.cell('XPDR\nOFF', WHITE, (L) => (pw(L) > 0.02 ? 1 : 0)),
      lights.cell('LINK S4', CYAN, (L, t) => (pw(L) > 0.2 ? (Math.sin(t * 0.7) > -0.8 ? 1 : 0.2) : 0)),
    ];
    const F = deckFrame(0, 0.8).child([0, 0.02, 0], [0.42, 0, 0]);
    F.rbox(M.carcass, 0.27, 0.03, 0.076, 0, -0.015, 0, 0.006);
    panel(F, ({
      w: 0.25,
      d: 0.062,
      ppm: 2400,
      items: cells.map((c, i) => ({ t: 'lit', x: -0.1 + (i % 5) * 0.05, z: i < 5 ? -0.0135 : 0.0135, w: 0.044, d: 0.022, cell: c })),
    }));
  }

  // Rocker banks just outboard of each pad.
  for (const side of [1, -1]) {
    const l = side > 0;
    panel(deckFrame(side * 0.79, 0.585), ({
      w: 0.13,
      d: 0.19,
      title: l ? 'EXT LIGHTS' : 'CABIN',
      items: [
        { t: 'rocker', x: -0.035, z: -0.03, label: l ? 'NAV' : 'FLOOD', up: true },
        { t: 'rocker', x: 0, z: -0.03, label: l ? 'STROBE' : 'PANEL' },
        { t: 'rocker', x: 0.035, z: -0.03, label: l ? 'BEACON' : 'DOME', up: false },
        { t: 'knob', x: -0.025, z: 0.04, r: 0.0095, label: 'DIM' },
        { t: 'led', x: 0.03, z: 0.028, cell: lights.cell('', l ? GREEN : AMBER, (L) => (pw(L) > 0.05 ? 1 : 0), true) },
        { t: 'led', x: 0.03, z: 0.048, cell: lights.cell('', CYAN, (L, t) => (pw(L) > 0.5 ? 0.6 + 0.4 * Math.sin(t * 3 + side) : 0), true) },
        { t: 'text', x: 0.03, z: 0.064, text: 'TEST', size: 0.0034 },
      ],
    }));
  }

  // Outboard wings: NAV / COMM keypad (left), POWER / FIELD (right).
  {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLR', '0', 'ENT'];
    panel(deckFrame(1.08, 0.72), ({
      w: 0.22,
      d: 0.4,
      title: 'NAV  ·  COMM',
      items: [
        { t: 'toggle', x: -0.07, z: -0.13, label: 'NAV' },
        { t: 'toggle', x: -0.035, z: -0.13, label: 'XPDR' },
        { t: 'toggle', x: 0, z: -0.13, label: 'LINK', up: false },
        { t: 'guard', x: 0.055, z: -0.128, label: 'SQUAWK EMER', color: 'red', id: 'emer' },
        { t: 'frame', x: 0, z: -0.123, w: 0.2, d: 0.07, label: 'MODE' },
        { t: 'knob', x: -0.055, z: -0.03, r: 0.013, label: 'FREQ' },
        { t: 'knob', x: -0.055, z: 0.05, r: 0.01, label: 'VOL' },
        ...keys.map((s, i) => ({ t: 'cap', x: 0.012 + (i % 3) * 0.031, z: -0.05 + Math.floor(i / 3) * 0.028, w: 0.025, d: 0.02, label: s })),
        { t: 'frame', x: 0.043, z: 0.006, w: 0.105, d: 0.13, label: 'DATA' },
        { t: 'rocker', x: -0.06, z: 0.125, label: 'ATC' },
        { t: 'rocker', x: -0.025, z: 0.125, label: 'S4 NET' },
        { t: 'led', x: 0.02, z: 0.12, cell: lights.cell('', GREEN, (L) => (pw(L) > 0.3 ? 1 : 0), true) },
        { t: 'led', x: 0.04, z: 0.12, cell: lights.cell('', AMBER, (L, t) => (pw(L) > 0.3 ? blink(t, 0.4) : 0), true) },
        { t: 'led', x: 0.06, z: 0.12, cell: lights.cell('', RED, () => 0, true) },
        { t: 'text', x: 0.04, z: 0.135, text: 'TX  RX  FAIL', size: 0.0032 },
        { t: 'text', x: 0, z: 0.178, text: 'CRYPTO KEYED · TS/SCI-MAJIC', size: 0.0032, weight: 500, color: 'rgba(217,221,214,0.55)' },
      ],
    }));
    panel(deckFrame(-1.08, 0.72), ({
      w: 0.22,
      d: 0.4,
      title: 'POWER  ·  FIELD',
      items: [
        ...['BUS A', 'BUS B', 'FLD 1', 'FLD 2', 'FLD 3'].map((s, i) => ({ t: 'toggle', x: -0.08 + i * 0.04, z: -0.13, label: s })),
        { t: 'frame', x: 0, z: -0.123, w: 0.205, d: 0.07, label: 'DISTRIBUTION' },
        ...[0, 1, 2].map((i) => ({ t: 'led', x: -0.06 + i * 0.03, z: -0.06, cell: lights.cell('', GREEN, (L) => (pw(L) > 0.25 + i * 0.3 ? 1 : 0), true) })),
        { t: 'text', x: -0.03, z: -0.045, text: 'AMP 1   AMP 2   AMP 3', size: 0.0032 },
        { t: 'knob', x: -0.05, z: 0.015, r: 0.014, label: 'FIELD TRIM' },
        { t: 'knob', x: 0.045, z: 0.015, r: 0.011, label: 'DAMPING' },
        { t: 'guard', x: -0.045, z: 0.11, label: 'FIELD DUMP', color: 'red', id: 'dump' },
        { t: 'stripe', x: 0.04, z: 0.112, w: 0.07, d: 0.05 },
        { t: 'text', x: 0.04, z: 0.15, text: 'MASTER KEY', size: 0.0042 },
        { t: 'text', x: 0, z: 0.18, text: 'ELEMENT 115 · HANDLE PER SOP 9-14', size: 0.0032, weight: 500, color: 'rgba(217,221,214,0.55)' },
      ],
    }));
    // the master key in its lock (right wing, on the stripes)
    const F = deckFrame(-1.08, 0.72);
    F.cyl(M.chrome, 0.012, 0.012, 0.004, 0.04, 0.0082, 0.112, null, 20);
    F.cyl(M.black, 0.008, 0.008, 0.005, 0.04, 0.012, 0.112, null, 16);
    F.box(M.brass, 0.003, 0.012, 0.006, 0.04, 0.019, 0.112, [0, 0.6, 0]);
    F.rbox(M.brass, 0.016, 0.014, 0.003, 0.04, 0.03, 0.112, 0.004, [0, 0.6, 0]);
    F.cyl(M.chrome, 0.004, 0.004, 0.003, 0.04, 0.04, 0.112, [Math.PI / 2, 0.6, 0], 10);
  }

  // Four standby gauges between the screens, tipped up at the eye.
  {
    const spots = [[0, 0.42], [1, 0.3], [2, -0.3], [3, -0.42]];
    const look = new Matrix4();
    for (const [i, a] of spots) {
      const r = 0.885;
      const p = polar(a, r);
      const pos = new Vector3(p.x, deckY(r) + 0.05, p.z);
      look.lookAt(EYE, pos, Y);
      const F = new Frame(b, look.clone().setPosition(pos));
      F.cyl(M.black, 0.041, 0.043, 0.04, 0, 0, -0.0235, [Math.PI / 2, 0, 0], 28);
      F.add(new TorusGeometry(0.0375, 0.0045, 8, 40), M.black, [0, 0, 0.0005]);
      F.box(M.carcass, 0.05, 0.05, 0.035, 0, -0.04, -0.022);
      const face = new CircleGeometry(0.0338, 40);
      const uv = face.attributes.uv;
      for (let k = 0; k < uv.count; k++) {
        const [u, v] = gauges.uv(i, uv.getX(k), uv.getY(k));
        uv.setXY(k, u, v);
      }
      F.add(face, M.gauge, [0, 0, -0.0015]);
      F.add(new CircleGeometry(0.035, 32), M.glass, [0, 0, 0.0025]);
      for (const s of [-1, 1]) F.cyl(M.alu, 0.0022, 0.0022, 0.003, s * 0.031, 0.031, 0.002, [Math.PI / 2, 0, 0], 8);
    }
  }

  // ---------------------------------------------------------------- MFD bezels

  for (const s of cockpit.screens) {
    const m = s.mesh;
    m.updateMatrix();
    const w = m.geometry.parameters.width;
    const h = m.geometry.parameters.height;
    const F = new Frame(b, m.matrix.clone());
    F.rbox(M.black, w + 0.052, h + 0.05, 0.018, 0, 0, -0.0098, 0.007, null, 3);
    F.rbox(M.carcass, w + 0.03, h + 0.03, 0.05, 0, 0, -0.04, 0.008);
    F.box(M.carcass, 0.07, 0.12, 0.04, 0, -h / 2 - 0.05, -0.045);
    const n = 5;
    for (let k = 0; k < n; k++) {
      const x = (k - (n - 1) / 2) * ((w * 0.86) / (n - 1));
      for (const yy of [h / 2 + 0.0128, -h / 2 - 0.0128]) F.rbox(M.panelEdge, 0.022, 0.0105, 0.006, x, yy, 0.0006, 0.0022);
    }
    for (const xx of [-w / 2 - 0.0135, w / 2 + 0.0135]) {
      for (let k = 0; k < 3; k++) F.rbox(M.panelEdge, 0.0105, 0.018, 0.006, xx, (k - 1) * (h * 0.32), 0.0006, 0.0022);
    }
    // brightness rockers + a tiny ambient-light sensor
    F.rbox(M.panelEdge, 0.009, 0.014, 0.005, -w / 2 - 0.0135, -h / 2 - 0.0128, 0.0004, 0.002);
    F.rbox(M.panelEdge, 0.009, 0.014, 0.005, w / 2 + 0.0135, -h / 2 - 0.0128, 0.0004, 0.002);
    F.cyl(M.glass, 0.002, 0.002, 0.002, w / 2 + 0.0135, h / 2 + 0.0128, 0.0005, [Math.PI / 2, 0, 0], 8);
    // sun hood
    F.rbox(M.black, w + 0.05, 0.006, 0.045, 0, h / 2 + 0.026, 0.012, 0.0025);
  }

  // ---------------------------------------------------------------- side consoles

  for (const side of [-1, 1]) {
    R.rbox(M.carcass, 0.34, 2.335 - FLOOR, 0.84, side * 0.61, (2.335 + FLOOR) / 2, 0.53, 0.012);
    R.rbox(M.leather, 0.065, 0.04, 0.62, side * 0.4725, 2.345, 0.56, 0.018);
    const top = (z) => new Frame(b, new Matrix4().makeTranslation(side * 0.643, 2.335, z));
    if (side < 0) {
      // drive spool quadrant
      panel(top(0.29), ({
        w: 0.27,
        d: 0.27,
        ppm: 1600,
        title: 'DRIVE SPOOL',
        items: [
          { t: 'slot', x: 0.035, z: 0.005, w: 0.016, d: 0.21, marks: [['FULL', -0.095], ['TRIM', -0.03], ['SPOOL', 0.035], ['IDLE', 0.095]] },
          { t: 'guard', x: -0.09, z: -0.06, label: 'CUT-OFF', color: 'red', id: 'cut' },
          { t: 'toggle', x: -0.09, z: 0.03, label: 'IGN A' },
          { t: 'toggle', x: -0.055, z: 0.03, label: 'IGN B' },
          { t: 'knob', x: -0.075, z: 0.09, r: 0.01, label: 'PHASE' },
        ],
      }));
      const lever = part('spool_lever', (Q) => {
        Q.box(M.black, 0.012, 0.004, 0.03, 0, 0.002, 0);
        Q.rbox(M.alu, 0.008, 0.07, 0.012, 0, 0.038, 0, 0.003, [0.25, 0, 0]);
        Q.rbox(M.rubber, 0.032, 0.026, 0.05, -0.01, 0.078, 0.01, 0.01, [0.25, 0, 0]);
        Q.cyl(M.red, 0.006, 0.006, 0.006, -0.012, 0.094, 0.0, [0.25, 0, 0], 12);
      });
      place(lever, top(0.29).local([0.035, 0.006, 0]));
      animated.push({ kind: 'spool', obj: lever, z0: 0.29 + 0.095, z1: 0.29 - 0.095 });
      extra.push(lever);
    } else {
      // strut handle + emergency ramp T-handle
      panel(top(0.29), ({
        w: 0.27,
        d: 0.27,
        ppm: 1600,
        title: 'STRUTS  ·  RAMP',
        items: [
          { t: 'slot', x: -0.04, z: 0.0, w: 0.016, d: 0.17, marks: [['UP', -0.075], ['DN', 0.075]] },
          { t: 'led', x: 0.035, z: -0.07, cell: lights.cell('', GREEN, (L) => ((L.strut ?? 1) > 0.98 ? 1 : 0), true) },
          { t: 'led', x: 0.06, z: -0.07, cell: lights.cell('', GREEN, (L) => ((L.strut ?? 1) > 0.98 ? 1 : 0), true) },
          { t: 'led', x: 0.085, z: -0.07, cell: lights.cell('', GREEN, (L) => ((L.strut ?? 1) > 0.98 ? 1 : 0), true) },
          { t: 'led', x: 0.06, z: -0.045, cell: lights.cell('', AMBER, (L) => ((L.strut ?? 1) > 0.02 && (L.strut ?? 1) < 0.98 ? 1 : 0), true) },
          { t: 'text', x: 0.06, z: -0.088, text: 'L   AFT   R', size: 0.0036 },
          { t: 'text', x: 0.06, z: -0.03, text: 'TRANSIT', size: 0.0034 },
          { t: 'stripe', x: 0.06, z: 0.065, w: 0.09, d: 0.07 },
          { t: 'text', x: 0.06, z: 0.112, text: 'EMERG RAMP · PULL', size: 0.0042, weight: 700 },
        ],
      }));
      const T = top(0.29);
      T.cyl(M.chrome, 0.004, 0.004, 0.024, 0.06, 0.018, 0.065, null, 10);
      T.rbox(M.hazard, 0.06, 0.012, 0.014, 0.06, 0.033, 0.065, 0.005);
      const lever = part('strut_lever', (Q) => {
        Q.box(M.black, 0.02, 0.008, 0.02, 0, 0.004, 0);
        Q.cyl(M.chrome, 0.0045, 0.0045, 0.075, 0, 0.04, 0, null, 12);
        Q.add(new TorusGeometry(0.014, 0.0055, 10, 24), M.white, [0, 0.083, 0], [Math.PI / 2, 0, 0]);
        Q.cyl(M.white, 0.01, 0.01, 0.008, 0, 0.083, 0, null, 18);
      });
      place(lever, T.local([-0.04, 0.006, 0]));
      animated.push({ kind: 'strut', obj: lever });
      extra.push(lever);
    }
    // breaker field
    const brk = [];
    const names = side < 0 ? ['FLD 1', 'FLD 2', 'FLD 3', 'AMP', 'WAVE', 'GYRO', 'NAV', 'XPDR', 'LINK', 'MFD L', 'MFD C', 'MFD R', 'CAB LT', 'PNL LT', 'O2', 'FAN', 'HTR', 'SPARE'] : ['BUS A', 'BUS B', 'STRUT L', 'STRUT R', 'STRUT A', 'RAMP', 'HATCH', 'EMIT 1', 'EMIT 2', 'EMIT 3', 'DAMP', 'TRIM', 'ADC', 'IMU', 'CLOCK', 'RECORD', 'BEACON', 'SPARE'];
    names.forEach((s, i) => brk.push({ t: 'breaker', x: -0.1025 + (i % 6) * 0.041, z: -0.07 + Math.floor(i / 6) * 0.05, label: s, amps: [5, 7.5, 10, 15, 3][i % 5], popped: s === 'SPARE' && side < 0 }));
    panel(top(0.57), ({ w: 0.27, d: 0.25, ppm: 1600, title: side < 0 ? 'CIRCUIT BREAKERS · DC' : 'CIRCUIT BREAKERS · FIELD', items: brk }));
    if (side < 0) {
      panel(top(0.845), ({
        w: 0.27,
        d: 0.25,
        ppm: 1600,
        title: 'ENVIRONMENT',
        items: [
          { t: 'knob', x: -0.075, z: -0.035, r: 0.013, label: 'TEMP' },
          { t: 'knob', x: -0.01, z: -0.035, r: 0.013, label: 'FLOW' },
          { t: 'toggle', x: 0.06, z: -0.045, label: 'O2' },
          { t: 'toggle', x: 0.095, z: -0.045, label: 'FAN', up: false },
          { t: 'rocker', x: -0.075, z: 0.06, label: 'DEFOG' },
          { t: 'rocker', x: -0.04, z: 0.06, label: 'PURGE', up: false },
          { t: 'led', x: 0.06, z: 0.055, cell: lights.cell('', GREEN, (L) => (pw(L) > 0.05 ? 1 : 0), true) },
          { t: 'text', x: 0.06, z: 0.07, text: 'O2 FLOW', size: 0.0034 },
        ],
      }));
    }
  }
  // checklist card on the right console, propped up
  {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 720;
    const draw = () => {
      const g = c.getContext('2d');
      g.fillStyle = '#e9e4d6';
      g.fillRect(0, 0, 512, 720);
      g.fillStyle = '#b8141a';
      g.fillRect(0, 0, 512, 54);
      text(g, 'ARV-3  NORMAL PROCEDURES', 256, 28, 26, { weight: 700, color: '#fff' });
      const lines = [
        ['BEFORE POWER-UP', null],
        ['Ramp', 'CLOSED'],
        ['Struts', 'DN · 3 GREEN'],
        ['Master key', 'ON'],
        ['BUS A / B', 'ON'],
        ['Hands', 'ON PADS'],
        ['SPOOL-UP', null],
        ['Drive arm', 'GUARD UP · ARM'],
        ['Spool (R)', 'TO FULL'],
        ['Field', 'GREEN 100%'],
        ['Hangar doors', 'CONFIRM OPEN'],
        ['DEPARTURE', null],
        ['Lift (SPACE)', 'SMOOTH'],
        ['Clear hangar', 'BEFORE O-DRV'],
        ['Overdrive (Q)', 'AS REQ'],
        ['Warp (J)', 'DEST SET · ENGAGE'],
      ];
      let y = 96;
      for (const [a, v] of lines) {
        if (!v) {
          text(g, a, 22, y, 22, { align: 'left', weight: 700, color: '#1d1d1d' });
          g.fillStyle = '#1d1d1d';
          g.fillRect(22, y + 14, 468, 2);
          y += 42;
          continue;
        }
        text(g, a, 34, y, 20, { align: 'left', weight: 500, color: '#262626', font: MONO });
        text(g, v, 490, y, 20, { align: 'right', weight: 600, color: '#262626', font: MONO });
        g.fillStyle = 'rgba(40,40,40,0.35)';
        for (let x = 250; x < 360; x += 8) g.fillRect(x, y + 2, 3, 2);
        y += 36;
      }
      text(g, 'T.O. 1-ARV3-1CL  ·  REV 9  ·  SECRET//NOFORN', 256, 700, 15, { color: '#444', font: MONO });
    };
    draw();
    const tx = new CanvasTexture(c);
    tx.colorSpace = SRGBColorSpace;
    tx.anisotropy = 8;
    const card = std({ name: 'cab_checklist', map: tx, roughness: 0.75, metalness: 0 });
    document.fonts?.ready.then(() => {
      draw();
      tx.needsUpdate = true;
    });
    const F = new Frame(b, new Matrix4().makeTranslation(0.643, 2.335, 0.84)).child([0, 0.05, 0], [-1.05, 0, 0]);
    F.rbox(M.olive, 0.17, 0.235, 0.008, 0, 0, -0.005, 0.004);
    F.add(new PlaneGeometry(0.15, 0.21), card, [0, -0.008, 0.0005]);
    F.rbox(M.alu, 0.07, 0.016, 0.01, 0, 0.105, 0.004, 0.004);
    new Frame(b, new Matrix4().makeTranslation(0.643, 2.335, 0.84)).box(M.olive, 0.17, 0.01, 0.1, 0, 0.005, 0.03);
  }

  // ---------------------------------------------------------------- seat

  {
    // shifted to meet the seated body (PilotBody): back cushion just behind the shoulder blades
    const S = new Frame(b, new Matrix4().makeTranslation(0, 0, -0.15));
    // pedestal + rails
    S.rbox(M.carcass, 0.3, 0.2, 0.42, 0, FLOOR + 0.1, 0.48, 0.02);
    for (const s of [-1, 1]) {
      S.box(M.alu, 0.03, 0.02, 0.62, s * 0.12, FLOOR + 0.01, 0.48);
      S.rbox(M.carcass, 0.03, 0.3, 0.52, s * 0.262, 1.995, 0.44, 0.01);
    }
    S.rbox(M.carcass, 0.52, 0.14, 0.03, 0, 1.985, 0.185, 0.012);
    // survival kit + pan cushion
    S.rbox(M.olive, 0.44, 0.07, 0.42, 0, 1.95, 0.44, 0.02);
    S.rbox(M.cushion, 0.47, 0.075, 0.47, 0, 2.02, 0.43, 0.03, [-0.04, 0, 0], 3);
    // back shell, cushion, headrest
    S.rbox(M.carcass, 0.52, 0.92, 0.05, 0, 2.56, 0.76, 0.02, [0.07, 0, 0]);
    S.rbox(M.cushion, 0.44, 0.68, 0.07, 0, 2.5, 0.71, 0.03, [0.07, 0, 0], 3);
    for (const s of [-1, 1]) S.rbox(M.cushion, 0.06, 0.5, 0.1, s * 0.215, 2.45, 0.69, 0.025, [0.07, s * 0.35, 0], 3);
    S.rbox(M.cushion, 0.27, 0.19, 0.1, 0, 3.0, 0.75, 0.035, [0.07, 0, 0], 3);
    for (const s of [-1, 1]) S.rbox(M.cushion, 0.05, 0.18, 0.11, s * 0.14, 3.0, 0.73, 0.02, [0.07, s * 0.5, 0], 3);
    // ejection-style rails behind the back, headbox
    for (const s of [-1, 1]) S.box(M.alu, 0.035, 1.25, 0.03, s * 0.2, 2.45, 0.82, [0.07, 0, 0]);
    S.rbox(M.carcass, 0.36, 0.14, 0.12, 0, 3.12, 0.86, 0.02, [0.07, 0, 0]);
    S.rbox(M.hazard, 0.08, 0.035, 0.02, 0, 3.12, 0.79, 0.006, [0.07, 0, 0]);
    // seat adjust handle
    S.cyl(M.black, 0.007, 0.007, 0.12, 0.28, 1.95, 0.2, [0, 0, Math.PI / 2], 10);
    S.rbox(M.hazard, 0.03, 0.02, 0.05, 0.34, 1.95, 0.2, 0.008);
  }

  // ---------------------------------------------------------------- floor details

  {
    // anti-slip mat under the feet, hatch behind the seat, tie-downs
    R.rbox(M.rubber, 0.78, 0.008, 0.5, 0, FLOOR + 0.004, -0.12, 0.004);
    const H = new Frame(nb, new Matrix4().makeTranslation(0, FLOOR, 1.55));
    H.add(lathe([[0.43, 0.0], [0.43, 0.012], [0.41, 0.016], [0.395, 0.012], [0.395, 0.0]], 64), M.alu);
    const lid = new CircleGeometry(0.395, 64);
    lid.rotateX(-Math.PI / 2);
    const luv = lid.attributes.uv;
    const lpos = lid.attributes.position;
    for (let i = 0; i < luv.count; i++) luv.setXY(i, lpos.getX(i) / 0.5, lpos.getZ(i) / 0.5);
    H.add(lid, M.deck, [0, 0.006, 0]);
    H.rbox(M.black, 0.16, 0.012, 0.04, 0, 0.012, -0.22, 0.005);
    H.cyl(M.chrome, 0.006, 0.006, 0.12, 0, 0.022, -0.22, [0, 0, Math.PI / 2], 10);
    for (const s of [-1, 1]) H.rbox(M.alu, 0.07, 0.018, 0.05, s * 0.2, 0.009, 0.36, 0.006);
    const hr = caps.alloc(360, 90, (g, W, h) => {
      g.fillStyle = '#d4a017';
      g.fillRect(0, 0, W, h);
      text(g, 'HATCH · KEEP CLEAR', W / 2, h / 2 + 2, h * 0.5, { weight: 700, color: '#111' });
    });
    H.add(facePlane(0.24, 0.06, caps.uv(hr, 0, 0), caps.uv(hr, 1, 1)), M.caps, [0, 0.013, 0.12]);
    for (const [x, z] of [[-1.5, 0.9], [1.5, 0.9], [-1.25, -1.35], [1.25, -1.35], [0, -1.9]]) {
      const T = new Frame(nb, new Matrix4().makeTranslation(x, FLOOR, z));
      T.cyl(M.alu, 0.035, 0.035, 0.006, 0, 0.003, 0, null, 16);
      T.add(new TorusGeometry(0.022, 0.0045, 8, 20), M.chrome, [0, 0.008, 0], [Math.PI / 2, 0, 0]);
    }
  }

  // ---------------------------------------------------------------- wall equipment

  {
    // left: equipment cabinet
    const L = wallFrame(-Math.PI / 2 - 0.12, 2.6);
    L.rbox(M.carcass, 0.9, 0.5, 0.34, 0, 0.25, 0.17, 0.012);
    L.rbox(M.panelEdge, 0.84, 0.44, 0.01, 0, 0.25, 0.343, 0.004);
    for (let k = 0; k < 14; k++) L.box(M.black, 0.3, 0.006, 0.006, -0.22, 0.12 + k * 0.02, 0.35);
    for (const x of [0.1, 0.32]) {
      L.rbox(M.black, 0.035, 0.06, 0.02, x, 0.36, 0.355, 0.006);
      L.cyl(M.chrome, 0.004, 0.004, 0.03, x, 0.36, 0.368, [Math.PI / 2, 0, 0], 8);
    }
    const cr = caps.alloc(400, 120, (g, W, h) => {
      g.fillStyle = '#e8e4d8';
      g.fillRect(0, 0, W, h);
      g.fillStyle = '#b8141a';
      g.fillRect(0, 0, W, 26);
      text(g, 'CAUTION', W / 2, 14, 20, { weight: 700, color: '#fff' });
      text(g, 'FIELD AMPLIFIER CONTROL', W / 2, 56, 22, { weight: 700, color: '#111' });
      text(g, 'DE-ENERGIZE BEFORE OPENING', W / 2, 92, 18, { weight: 500, color: '#222' });
    });
    L.add(facePlane(0.2, 0.06, caps.uv(cr, 0, 0), caps.uv(cr, 1, 1)).rotateX(Math.PI / 2), M.caps, [0.21, 0.2, 0.349]);
    for (let k = 0; k < 4; k++) {
      const c = lights.cell('', k === 3 ? AMBER : GREEN, (Lv, t) => (pw(Lv) > 0.1 + k * 0.25 ? (k === 3 ? blink(t, 0.7) : 1) : 0), true);
      L.add(solidUV(new SphereGeometry(0.006, 10, 6), lights.uv(c, 0.5, 0.5)), M.lights, [0.12 + k * 0.03, 0.43, 0.35]);
    }
    // right: O2 bottle, extinguisher, first-aid box
    const Rt = wallFrame(Math.PI / 2 + 0.15, 2.6);
    Rt.cyl(M.o2, 0.085, 0.085, 0.3, -0.25, 0.15, 0.13, null, 24);
    Rt.sphere(M.o2, 0.085, -0.25, 0.3, 0.13, 20);
    Rt.cyl(M.chrome, 0.022, 0.028, 0.045, -0.25, 0.4, 0.13, null, 12);
    Rt.cyl(M.black, 0.032, 0.032, 0.018, -0.25, 0.43, 0.13, null, 12);
    for (const y of [0.08, 0.26]) Rt.box(M.webbing, 0.19, 0.035, 0.012, -0.25, y, 0.218);
    // O2 shutoff placard beside the bottle, on a bracket
    const o2r = caps.alloc(360, 110, (g, W, h) => {
      g.fillStyle = '#2f6b3a';
      g.fillRect(0, 0, W, h);
      g.strokeStyle = '#e8eee6';
      g.lineWidth = 4;
      g.strokeRect(6, 6, W - 12, h - 12);
      text(g, 'O2 SHUTOFF \u25B8', W / 2, 44, 34, { weight: 700, color: '#f2f5ee' });
      text(g, 'TURN CW TO CLOSE', W / 2, 82, 19, { weight: 500, color: '#dfe7db' });
    });
    Rt.rbox(M.black, 0.17, 0.056, 0.03, -0.49, 0.3, -0.012, 0.004);
    Rt.add(facePlane(0.155, 0.047, caps.uv(o2r, 0, 0), caps.uv(o2r, 1, 1)).rotateX(Math.PI / 2), M.caps, [-0.49, 0.3, 0.0035]);
    Rt.cyl(M.ext, 0.06, 0.06, 0.34, 0.05, 0.2, 0.11, null, 20);
    Rt.sphere(M.ext, 0.06, 0.05, 0.37, 0.11, 16);
    Rt.cyl(M.black, 0.015, 0.02, 0.05, 0.05, 0.43, 0.11, null, 10);
    Rt.rbox(M.black, 0.08, 0.015, 0.02, 0.07, 0.455, 0.11, 0.005);
    Rt.add(new TubeGeometry(new CatmullRomCurve3([new Vector3(0.09, 0.44, 0.11), new Vector3(0.13, 0.4, 0.14), new Vector3(0.12, 0.2, 0.17), new Vector3(0.09, 0.08, 0.16)]), 16, 0.007, 6), M.black);
    for (const y of [0.1, 0.3]) Rt.box(M.alu, 0.14, 0.02, 0.01, 0.05, y, 0.175);
    Rt.rbox(M.white, 0.22, 0.16, 0.1, 0.34, 0.3, 0.05, 0.012);
    Rt.box(M.red, 0.06, 0.02, 0.002, 0.34, 0.3, 0.101);
    Rt.box(M.red, 0.02, 0.06, 0.002, 0.34, 0.3, 0.101);
    // rear: avionics rack (LRUs on a tray), cable runs into the floor
    const B = wallFrame(0, 2.55);
    B.box(M.alu, 1.5, 0.025, 0.42, 0, 0.12, 0.2);
    for (const s of [-1, 1]) B.box(M.alu, 0.03, 0.48, 0.42, s * 0.75, 0.24, 0.2);
    const lru = [[-0.56, 0.32, 0.3], [-0.22, 0.28, 0.34], [0.12, 0.3, 0.3], [0.46, 0.34, 0.26]];
    lru.forEach(([x, w, h], k) => {
      B.rbox(k % 2 ? M.carcass : M.olive, w, h, 0.36, x, 0.135 + h / 2, 0.2, 0.008);
      B.rbox(M.black, w - 0.02, h - 0.03, 0.012, x, 0.135 + h / 2, 0.385, 0.004);
      for (const hx of [-w / 2 + 0.03, w / 2 - 0.03]) B.cyl(M.chrome, 0.005, 0.005, 0.05, x + hx, 0.135 + h / 2, 0.4, [0, 0, 0], 8);
      for (let c = 0; c < 2; c++) {
        B.cyl(M.alu, 0.018, 0.018, 0.02, x - 0.05 + c * 0.1, 0.135 + h * 0.3, 0.395, [Math.PI / 2, 0, 0], 14);
        B.cyl(M.black, 0.014, 0.014, 0.03, x - 0.05 + c * 0.1, 0.135 + h * 0.3, 0.41, [Math.PI / 2, 0, 0], 12);
      }
      const cl = lights.cell('', k === 2 ? AMBER : GREEN, (Lv, t) => (pw(Lv) > 0.05 ? (k === 2 ? (Math.sin(t * 5 + k) > 0.3 ? 1 : 0.2) : 1) : 0), true);
      B.add(solidUV(new SphereGeometry(0.005, 10, 6), lights.uv(cl, 0.5, 0.5)), M.lights, [x + w / 2 - 0.04, 0.135 + h - 0.04, 0.393]);
      const curve = new CatmullRomCurve3([
        new Vector3(x - 0.05, 0.135 + h * 0.3, 0.43),
        new Vector3(x - 0.04, 0.09, 0.5),
        new Vector3(x * 0.6, 0.012, 0.75 + k * 0.05),
        new Vector3(x * 0.3, 0.01, 1.05),
      ]);
      B.add(new TubeGeometry(curve, 24, 0.011, 6), k % 2 ? M.cableOrange : M.cable);
    });
  }

  // ---------------------------------------------------------------- lights

  const dome = new PointLight(0xffe6c8, 0.0, 3.2, 2);
  dome.position.set(0, 3.25, 1.2);
  const kick = new PointLight(0xbfd8ff, 0.0, 2.2, 2);
  kick.position.set(0, 1.95, -0.6);
  cockpit.root.add(dome, kick);

  for (const m of b.build({ name: 'cabin' })) cockpit.root.add(m);
  for (const m of nb.build({ name: 'cabin_shell', castShadow: false })) cockpit.root.add(m);
  for (const g of extra) {
    g.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    cockpit.root.add(g);
  }
  document.fonts?.ready.then(() => {
    atlas.redraw();
    caps.redraw();
    lights.redraw();
  });
  atlas.texture.needsUpdate = true;
  caps.texture.needsUpdate = true;

  let spool = 0;
  let strut = 1;
  return {
    mats,
    update(dt, t, live) {
      lights.update(dt, t, live);
      gauges.update(dt, t, live);
      const p = live.power ?? 0;
      dome.intensity = 0.06 + 0.12 * p;
      kick.intensity = 0.05 * p;
      M.led.color.setScalar(0.25 + 1.1 * p);
      spool += ((p > 0.5 ? 1 : p > 0.02 ? 0.55 : 0) - spool) * Math.min(1, dt * 4);
      strut += ((live.strut ?? 1) - strut) * Math.min(1, dt * 5);
      for (const a of animated) {
        if (a.kind === 'guard') {
          const want = a.id === 'arm' ? (p > 0.01 ? 1 : 0) : a.id === 'od' ? (live.overdrive ? 1 : 0) : 0;
          a.v += (want - a.v) * Math.min(1, dt * 6);
          a.obj.rotation.x = -1.75 * a.v;
        } else if (a.kind === 'selector') {
          const idx = p < 0.01 ? 0 : p < 0.5 ? 1 : live.overdrive ? 3 : 2;
          a.v += (a.angles[idx] - a.v) * Math.min(1, dt * 10);
          a.obj.rotation.y = -a.v;
        } else if (a.kind === 'spool') {
          a.obj.position.z = a.z0 + (a.z1 - a.z0) * spool;
        } else if (a.kind === 'strut') {
          a.obj.rotation.x = 0.55 * strut - 0.55 * (1 - strut);
        }
      }
    },
  };
}
