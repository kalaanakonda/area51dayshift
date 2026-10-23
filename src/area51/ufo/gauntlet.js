import { BufferGeometry, CanvasTexture, Float32BufferAttribute, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshStandardMaterial, SRGBColorSpace, Vector2, Vector3 } from 'three';
import { normalFromHeight } from '../textures.js';
import { mulberry32 } from '../../core/math.js';

/**
 * Glove gauntlets tailored to the pilot: each one is built around what it has
 * to cover — the glove's wrist and the end of the flight-suit sleeve (cut 3 cm
 * up the forearm by scripts/rocketbox_pilot.py) — measured from the skinned
 * meshes as they sit on the pads. Snug over the wrist under a hook-and-loop
 * strap, flaring over the sleeve end and following the sleeve, a rolled
 * binding at the rim, sage Nomex with a stitched seam down the little-finger
 * side.
 *
 * Cuff frame: +Y runs from the wrist joint up the forearm, +Z is the back of
 * the wrist, X = Y × Z. θ = atan2(x, z) (0 on the back of the wrist).
 */
const NA = 48; // segments around
const T0 = -0.016; // starts inside the glove
const T1 = 0.07; // rim
const STRAP = [-0.004, 0.009];
const BANDS = 10; // sleeve sections, 5 mm apart from its end
const CLEAR = 0.0022;
const TEX = 512;
const BODY_H = 420; // canvas rows for the outer surface (rim at the top)
const STRAP_Y = [432, 470];
const TAB_Y = [476, 508];
const BIND = 26; // binding tape, canvas rows

function smooth01(x) {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

const binOf = (th) => ((Math.round((th / (Math.PI * 2)) * NA) % NA) + NA) % NA;

/** Max radius per angle of samples with t in [t0, t1): gaps filled, a little smoothed. */
function envelope(pts, t0, t1) {
  const e = new Float32Array(NA);
  let n = 0;
  for (const p of pts) {
    if (p.t < t0 || p.t >= t1) continue;
    const k = binOf(p.th);
    if (p.r > e[k]) e[k] = p.r;
    n++;
  }
  if (n < 8) return null;
  const out = new Float32Array(NA);
  for (let k = 0; k < NA; k++) {
    if (e[k] > 0) {
      out[k] = e[k];
      continue;
    }
    // nearest filled bins either side
    let a = 1;
    let b = 1;
    while (a < NA && !(e[(k - a + NA) % NA] > 0)) a++;
    while (b < NA && !(e[(k + b) % NA] > 0)) b++;
    out[k] = (e[(k - a + NA) % NA] * b + e[(k + b) % NA] * a) / (a + b);
  }
  // conservative smoothing: max over ±1 bin, then a ±2 bin average
  const m = new Float32Array(NA);
  for (let k = 0; k < NA; k++) m[k] = Math.max(out[(k + NA - 1) % NA], out[k], out[(k + 1) % NA]);
  const s = new Float32Array(NA);
  for (let k = 0; k < NA; k++) {
    let sum = 0;
    for (let d = -2; d <= 2; d++) sum += m[(k + d + NA) % NA];
    s[k] = sum / 5;
  }
  return s;
}

/**
 * `points`: { t, th, r, glove } samples of the glove and sleeve surfaces in the
 * cuff frame (sampleCover). Returns R(k, t), the gauntlet radius at angle bin
 * k and distance t along the forearm, or null when the sleeve is not there.
 */
export function fitGauntlet(points) {
  const glove = points.filter((p) => p.glove);
  const sleeve = points.filter((p) => !p.glove);
  if (sleeve.length < 40) return null;
  const wrist = envelope(glove, -0.012, 0.004) || new Float32Array(NA).fill(0.031);
  // where the sleeve ends (its cut ring), robust to a stray vertex
  const ts = sleeve.map((p) => p.t).sort((a, b) => a - b);
  const tEnd = ts[Math.floor(ts.length * 0.01)];
  const bands = [];
  for (let b = 0; b < BANDS; b++) {
    const tb = tEnd + 0.002 + b * 0.005;
    bands.push(envelope(sleeve, tb - 0.004, tb + 0.004) || (b ? bands[b - 1] : wrist));
  }
  // a gauntlet never narrows toward the elbow
  for (let b = 1; b < BANDS; b++) bands[b] = bands[b].map((r, k) => Math.max(r, bands[b - 1][k]));
  const sleeveAt = (k, t) => {
    const f = Math.max(0, Math.min(BANDS - 1.001, (t - tEnd - 0.002) / 0.005));
    const i = Math.floor(f);
    return bands[i][k] + (bands[i + 1][k] - bands[i][k]) * (f - i);
  };
  const snug = (k) => wrist[k] + CLEAR;
  const e0 = STRAP[0] - 0.003;
  const f0 = STRAP[1] + 0.002;
  const f1 = Math.max(f0 + 0.008, tEnd - 0.001);
  const R = (k, t) => {
    if (t < e0) return snug(k) - 0.0045 * smooth01((e0 - t) / (e0 - T0)); // emerges from the glove
    if (t < f0) return snug(k);
    const cover = Math.max(snug(k), sleeveAt(k, t) + CLEAR + 0.0004);
    return snug(k) + (cover - snug(k)) * smooth01((t - f0) / (f1 - f0));
  };
  R.tEnd = tEnd;
  return R;
}

/** Gathers above the strap, soft lengthwise creases toward the rim. */
function fold(th, t) {
  const gather = Math.sin(th * 7 + 1.7 * Math.sin(th * 3 + 0.4)) * 0.0008 * smooth01((t - STRAP[1]) / 0.004) * (1 - smooth01((t - STRAP[1] - 0.012) / 0.01));
  const crease = Math.sin(th * 5 + t * 70 + 2.1) * 0.0006 * smooth01((t - 0.03) / 0.015);
  return gather + crease;
}

/** Gauntlet + strap + tab, one geometry. side −1 left / +1 right. */
export function gauntletGeometry(R, side) {
  const pos = [];
  const uv = [];
  const idx = [];
  // u around, mirrored on the left hand so the seam and the tab sit on the same anatomical side
  const uOf = (j) => (side < 0 ? 1 - j / NA : j / NA);
  const vBody = (t) => 1 - ((T1 - t) / (T1 - T0)) * (BODY_H / TEX);
  let rings = 0;
  const ring = (rows) => {
    const base = pos.length / 3;
    for (const row of rows) {
      for (let j = 0; j <= NA; j++) {
        const k = j % NA;
        const th = (j / NA) * Math.PI * 2;
        const r = row.r ? row.r(k) : R(k, row.t) + fold(th, row.t);
        pos.push(Math.sin(th) * r, row.t, Math.cos(th) * r);
        uv.push(uOf(j), row.v);
      }
    }
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < NA; j++) {
        const a = base + i * (NA + 1) + j;
        const b = a + NA + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    rings += rows.length;
  };
  // outer surface from the wrist end to the rim, then the binding rolling over to the inside
  const rows = [];
  for (let t = T0; t < T1 - 0.0035; t += 0.003) rows.push({ t, v: vBody(t) });
  const rim = (k, dr) => R(k, T1 - 0.001) + dr;
  rows.push({ t: T1 - 0.0025, v: vBody(T1 - 0.0025), r: (k) => rim(k, 0.0005) });
  rows.push({ t: T1 - 0.0004, v: vBody(T1 - 0.0004), r: (k) => rim(k, 0.0004) });
  rows.push({ t: T1 + 0.0008, v: 1 - 2 / TEX, r: (k) => rim(k, -0.0011) });
  rows.push({ t: T1 - 0.0004, v: 1 - 1 / TEX, r: (k) => rim(k, -0.0026) });
  rows.push({ t: T1 - 0.007, v: 1 - 0.5 / TEX, r: (k) => rim(k, -0.0034) });
  ring(rows);
  // strap: a webbing band over the snug wrist, rounded edges
  const sv = (y) => 1 - y / TEX;
  const sR = (k, dr) => R(k, (STRAP[0] + STRAP[1]) / 2) + dr;
  const [s0, s1] = STRAP;
  ring([
    { t: s0 + 0.0003, v: sv(STRAP_Y[1]), r: (k) => sR(k, -0.0004) },
    { t: s0 + 0.0001, v: sv(STRAP_Y[1] - 2), r: (k) => sR(k, 0.0016) },
    { t: s0 + 0.0011, v: sv(STRAP_Y[1] - 6), r: (k) => sR(k, 0.0026) },
    { t: s1 - 0.0011, v: sv(STRAP_Y[0] + 6), r: (k) => sR(k, 0.0026) },
    { t: s1 - 0.0001, v: sv(STRAP_Y[0] + 2), r: (k) => sR(k, 0.0016) },
    { t: s1 - 0.0003, v: sv(STRAP_Y[0]), r: (k) => sR(k, -0.0004) },
  ]);
  // tab: the strap's free end lying over it, thumb side of the back of the wrist
  const tabC = 0.9 * side;
  const tabW = 0.62;
  const NT = 10;
  const tb = pos.length / 3;
  const tabRows = [
    [s0 + 0.0009, 0.0028, TAB_Y[1]],
    [s0 + 0.0017, 0.0046, TAB_Y[1] - 5],
    [s1 - 0.0017, 0.0046, TAB_Y[0] + 5],
    [s1 - 0.0009, 0.0028, TAB_Y[0]],
  ];
  for (const [t, dr, y] of tabRows) {
    for (let j = 0; j <= NT; j++) {
      const f = j / NT;
      const th = tabC + (f - 0.5) * tabW;
      const end = side > 0 ? f : 1 - f; // 0 sewn down, 1 free
      // the free end curls down onto the strap
      const r = sR(binOf(th), dr - 0.0022 * smooth01((end - 0.82) / 0.18));
      pos.push(Math.sin(th) * r, t, Math.cos(th) * r);
      uv.push(0.005 + end * 0.1, sv(y));
    }
  }
  for (let i = 0; i < tabRows.length - 1; i++) {
    for (let j = 0; j < NT; j++) {
      const a = tb + i * (NT + 1) + j;
      const b = a + NT + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  weldSeamNormals(g, rings);
  return g;
}

/** Every ring repeats its first vertex at the u seam: give both copies the averaged normal. */
function weldSeamNormals(g, rings) {
  const n = g.attributes.normal;
  for (let r = 0; r < rings; r++) {
    const a = r * (NA + 1);
    const b = a + NA;
    const x = n.getX(a) + n.getX(b);
    const y = n.getY(a) + n.getY(b);
    const z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l);
    n.setXYZ(b, x / l, y / l, z / l);
  }
  n.needsUpdate = true;
}

/** Dashed thread: light dashes on the colour, dimples in the height. */
function stitches(g, h, x0, y0, x1, y1, step, color) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.floor(len / step));
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  g.strokeStyle = color;
  g.lineWidth = 1.3;
  h.fillStyle = '#3c3c3c';
  for (let i = 0; i < n; i++) {
    const ax = x0 + ux * i * step;
    const ay = y0 + uy * i * step;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(ax + ux * step * 0.6, ay + uy * step * 0.6);
    g.stroke();
    h.fillRect(ax - 0.8, ay - 0.8, 1.6, 1.6);
  }
}

let shared = null;
/** Sage Nomex, darker binding, little-finger-side seam; webbing strap; tab with a box-X. */
export function gauntletMaterial() {
  if (shared) return shared;
  const rand = mulberry32(19);
  const c = document.createElement('canvas');
  c.width = c.height = TEX;
  const g = c.getContext('2d');
  const hc = document.createElement('canvas');
  hc.width = hc.height = TEX;
  const h = hc.getContext('2d');
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TEX, TEX);

  // body fabric, mottled
  g.fillStyle = '#5d6249';
  g.fillRect(0, 0, TEX, BODY_H + 6);
  for (let i = 0; i < 900; i++) {
    const r = 6 + rand() * 30;
    g.fillStyle = rand() < 0.5 ? `rgba(40,42,32,${0.02 + rand() * 0.04})` : `rgba(130,134,108,${0.02 + rand() * 0.03})`;
    g.beginPath();
    g.ellipse(rand() * TEX, rand() * BODY_H, r, r * 0.6, rand() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // twill: fine diagonal ribs
  h.save();
  h.beginPath();
  h.rect(0, 0, TEX, BODY_H);
  h.clip();
  h.lineWidth = 1.2;
  for (let k = -BODY_H; k < TEX; k += 3) {
    h.strokeStyle = (k / 3) % 2 ? '#959595' : '#6a6a6a';
    h.beginPath();
    h.moveTo(k, 0);
    h.lineTo(k + BODY_H, BODY_H);
    h.stroke();
  }
  h.restore();
  // grime: the palm side (u 0.5) from the pads, the wrist end, the rim
  const along = g.createLinearGradient(0, 0, 0, BODY_H);
  along.addColorStop(0, 'rgba(30,30,24,0.12)');
  along.addColorStop(0.6, 'rgba(30,30,24,0.0)');
  along.addColorStop(1, 'rgba(30,30,24,0.2)');
  g.fillStyle = along;
  g.fillRect(0, 0, TEX, BODY_H);
  const palm = g.createLinearGradient(TEX * 0.3, 0, TEX * 0.7, 0);
  palm.addColorStop(0, 'rgba(28,28,22,0)');
  palm.addColorStop(0.5, 'rgba(28,28,22,0.24)');
  palm.addColorStop(1, 'rgba(28,28,22,0)');
  g.fillStyle = palm;
  g.fillRect(0, 0, TEX, BODY_H);
  // seam down the little-finger side (u 0.75): welt between two stitch lines
  const sx = TEX * 0.75;
  const welt = h.createLinearGradient(sx - 7, 0, sx + 7, 0);
  welt.addColorStop(0, '#808080');
  welt.addColorStop(0.35, '#b8b8b8');
  welt.addColorStop(0.5, '#383838');
  welt.addColorStop(0.65, '#b8b8b8');
  welt.addColorStop(1, '#808080');
  h.fillStyle = welt;
  h.fillRect(sx - 7, BIND, 14, BODY_H - BIND);
  g.fillStyle = 'rgba(22,23,18,0.55)';
  g.fillRect(sx - 0.8, BIND, 1.6, BODY_H - BIND);
  for (const dx of [-5, 5]) stitches(g, h, sx + dx, BIND + 4, sx + dx, BODY_H - 8, 5, 'rgba(176,178,150,0.75)');
  // binding tape at the rim, stitched through
  g.fillStyle = '#45483b';
  g.fillRect(0, 0, TEX, BIND);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(0, BIND - 1, TEX, 2);
  h.fillStyle = '#a4a4a4';
  h.fillRect(0, 0, TEX, BIND - 2);
  h.fillStyle = '#4c4c4c';
  h.fillRect(0, BIND - 2, TEX, 3);
  stitches(g, h, 0, BIND - 7, TEX, BIND - 7, 5, 'rgba(160,162,136,0.7)');
  g.fillStyle = '#383b30';
  g.fillRect(0, 0, TEX, 3); // inner lip

  // strap: webbing ribs along its length, stitched edges
  const webbing = (x0, x1, y0, y1) => {
    g.fillStyle = '#484b3c';
    g.fillRect(x0, y0 - 3, x1 - x0, y1 - y0 + 6);
    for (let y = y0; y < y1; y += 2) {
      h.fillStyle = (y - y0) % 4 ? '#9a9a9a' : '#6c6c6c';
      h.fillRect(x0, y, x1 - x0, 1);
    }
    for (let i = 0; i < ((x1 - x0) * (y1 - y0)) / 50; i++) {
      g.fillStyle = `rgba(${rand() < 0.5 ? '20,21,16' : '110,114,92'},${0.05 + rand() * 0.06})`;
      g.fillRect(x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0), 2 + rand() * 6, 1);
    }
  };
  webbing(0, TEX, STRAP_Y[0], STRAP_Y[1]);
  stitches(g, h, 0, STRAP_Y[0] + 5, TEX, STRAP_Y[0] + 5, 4, 'rgba(150,152,126,0.7)');
  stitches(g, h, 0, STRAP_Y[1] - 5, TEX, STRAP_Y[1] - 5, 4, 'rgba(150,152,126,0.7)');
  // tab (u 0 sewn down … 0.1 free end): stitched border, box-X where it is sewn
  const tx1 = Math.round(TEX * 0.11);
  webbing(0, tx1, TAB_Y[0], TAB_Y[1]);
  const [ty0, ty1] = [TAB_Y[0] + 5, TAB_Y[1] - 5];
  stitches(g, h, 3, ty0, tx1 - 6, ty0, 4, 'rgba(150,152,126,0.75)');
  stitches(g, h, 3, ty1, tx1 - 6, ty1, 4, 'rgba(150,152,126,0.75)');
  stitches(g, h, tx1 - 6, ty0, tx1 - 6, ty1, 4, 'rgba(150,152,126,0.75)');
  const bx0 = 6;
  const bx1 = 22;
  for (const [a, b, c2, d] of [[bx0, ty0, bx1, ty0], [bx1, ty0, bx1, ty1], [bx1, ty1, bx0, ty1], [bx0, ty1, bx0, ty0], [bx0, ty0, bx1, ty1], [bx1, ty0, bx0, ty1]]) {
    stitches(g, h, a, b, c2, d, 3, 'rgba(150,152,126,0.85)');
  }

  const map = new CanvasTexture(c);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 8;
  map.minFilter = LinearMipmapLinearFilter;
  map.magFilter = LinearFilter;
  const px = h.getImageData(0, 0, TEX, TEX).data;
  const hf = new Float32Array(TEX * TEX);
  for (let i = 0; i < hf.length; i++) hf[i] = px[i * 4] / 255;
  const normalMap = normalFromHeight(hf, TEX, TEX, 2.4, { topDown: true });
  shared = new MeshStandardMaterial({ name: 'glove_gauntlet', map, normalMap, normalScale: new Vector2(0.9, 0.9), roughness: 0.92, metalness: 0, envMapIntensity: 0.5 });
  return shared;
}

/**
 * Sample glove and sleeve surfaces around a wrist, in the cuff frame
 * { origin, x, y, z } given in `space`'s coordinates.
 */
export function sampleCover(parts, frame, space) {
  const out = [];
  const p = new Vector3();
  const d = new Vector3();
  for (const { mesh, glove } of parts) {
    const n = mesh.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) {
      mesh.getVertexPosition(i, p);
      mesh.localToWorld(p);
      space.worldToLocal(p);
      d.subVectors(p, frame.origin);
      const t = d.dot(frame.y);
      if (glove ? t < -0.014 || t > 0.006 : t < -0.004 || t > 0.085) continue;
      const x = d.dot(frame.x);
      const z = d.dot(frame.z);
      const r = Math.hypot(x, z);
      if (r > 0.085) continue;
      out.push({ t, th: Math.atan2(x, z), r, glove });
    }
  }
  return out;
}

export function gauntletMesh(R, side) {
  const m = new Mesh(gauntletGeometry(R, side), gauntletMaterial());
  m.name = `gauntlet_${side < 0 ? 'left' : 'right'}`;
  m.castShadow = true;
  m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}
