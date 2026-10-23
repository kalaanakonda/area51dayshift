// pbf + @mapbox/vector-tile are installed with 3d-tiles-renderer (its MVT overlay uses them).
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { Earcut } from 'three/src/extras/Earcut.js';

/**
 * Building tiles, off the main thread: fetch one OpenMapTiles vector tile
 * (OpenFreeMap, z14) and the Terrarium elevation tile at the same address,
 * take the `building` layer, clip every footprint to the tile (neighbouring
 * tiles meet without overlapping roofs), extrude it and find the ground under
 * it — so a tile is ready to stand up the moment it arrives.
 *
 * Geometry is in tile-local metres around the tile centre — x east, y up,
 * z south — with y measured from the building's own base. The main thread
 * lifts each building onto its ground in the vertex shader.
 *
 * Two levels of detail, like an open-world game's LOD models:
 *   far   only what reads from kilometres away — tall buildings and big
 *         halls, and whatever those stand on
 *   near  everything, the far set first, so a near mesh drawn up to
 *         `lodIndexCount` is exactly the far mesh
 *
 * A building:part that starts in the air (a skyscraper's upper tier) takes the
 * centroid and ground of the part it stands on, so the two always meet.
 *
 * in : { type: 'tile', id, url, dem, z, x, y, lat0, lon0, level, exclude, maxBuildings }
 * out: { type: 'tile', id, ok, level, count, lodCount, lodIndexCount, bounds,
 *        position, normal, color, bld, index, centroid (lat, lon), xz (local m), ground }
 */
const DEG = Math.PI / 180;
const LOD_TOP = 25; // m: tall enough to stand out from kilometres away
const LOD_AREA = 3000; // m²: or big enough (stadiums, halls, terminals)

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'tile') return;
  try {
    const [r, dem] = await Promise.all([fetch(m.url), loadDem(m.dem)]);
    if (r.status === 204 || r.status === 404) return post({ id: m.id, ok: true, level: m.level, count: 0 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const out = buf.byteLength ? build(buf, dem, m) : { count: 0 };
    post({ id: m.id, ok: true, level: m.level, ...out });
  } catch (err) {
    post({ id: m.id, ok: false, error: String(err) });
  }
};

function post(msg) {
  const transfer = [];
  for (const k of ['position', 'normal', 'color', 'bld', 'index', 'centroid', 'xz', 'ground']) if (msg[k]) transfer.push(msg[k].buffer);
  self.postMessage({ type: 'tile', ...msg }, transfer);
}

/** Terrarium heights for the tile, or null (the main thread then falls back on the loaded terrain). */
async function loadDem(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const { width: w, height: h } = bmp;
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return { w, h, px: ctx.getImageData(0, 0, w, h).data };
  } catch {
    return null;
  }
}

/** Bilinear Terrarium height at tile-unit coordinates (0..1, y down). */
function demAt({ w, h, px }, u, v) {
  const x = Math.min(w - 1, Math.max(0, u * w - 0.5));
  const y = Math.min(h - 1, Math.max(0, v * h - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const at = (i, j) => {
    const o = (j * w + i) * 4;
    return px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
  };
  const fx = x - x0;
  const fy = y - y0;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

function build(buf, dem, { z, x, y, lat0, lon0, level, exclude = [], maxBuildings = 8000 }) {
  const tile = new VectorTile(new Pbf(buf));
  const layer = tile.layers.building;
  if (!layer || !layer.length) return { count: 0 };
  const E = layer.extent;
  const n = 2 ** z;
  // metres per degree around the tile centre (WGS84)
  const mLat = 111132.954 - 559.822 * Math.cos(2 * lat0 * DEG) + 1.175 * Math.cos(4 * lat0 * DEG);
  const mLon = 111412.84 * Math.cos(lat0 * DEG) - 93.5 * Math.cos(3 * lat0 * DEG);
  const toLocal = (p) => {
    const lon = ((x + p.x / E) / n) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + p.y / E)) / n))) / DEG;
    return [(lon - lon0) * mLon, -(lat - lat0) * mLat];
  };
  let rnd = (x * 73856093) ^ (y * 19349663);
  const rand = () => {
    rnd = (rnd * 1664525 + 1013904223) | 0;
    return (rnd >>> 0) / 4294967296;
  };

  // 1. footprints, in feature order — the same for both levels, so a building looks the same in each
  const items = [];
  for (let i = 0; i < layer.length && items.length < maxBuildings; i++) {
    const f = layer.feature(i);
    if (f.type !== 3) continue;
    const p = f.properties;
    if (p.hide_3d) continue;
    const top = Math.min(600, Math.max(3, +p.render_height || 6));
    const minH = Math.max(0, +p.render_min_height || 0);
    if (top - minH < 1) continue;

    // clip to the tile, close-point removed, into local metres; first ring's winding = exterior
    const polys = [];
    let extSign = 0;
    for (const r of f.loadGeometry()) {
      const tileRing = clip(r, E);
      if (tileRing.length < 3) continue;
      const ring = tileRing.map(toLocal);
      const a = area(ring);
      if (Math.abs(a) < 0.5) continue;
      const s = Math.sign(a);
      if (!extSign) extSign = s;
      if (s === extSign) polys.push({ rings: [ring], tileRing });
      else if (polys.length) polys[polys.length - 1].rings.push(ring);
    }
    for (const { rings, tileRing } of polys) {
      // exterior positive area, holes negative: then (dz, −dx) is always the outward wall normal
      if (area(rings[0]) < 0) rings[0].reverse();
      for (let h = 1; h < rings.length; h++) if (area(rings[h]) > 0) rings[h].reverse();
      const footprint = area(rings[0]);
      if (footprint < 12) continue;
      let cx = 0;
      let cz = 0;
      for (const [px, pz] of rings[0]) {
        cx += px;
        cz += pz;
      }
      cx /= rings[0].length;
      cz /= rings[0].length;
      const lat = lat0 - cz / mLat;
      const lon = lon0 + cx / mLon;
      if (exclude.some((ex) => Math.hypot((lon - ex.lon) * mLon, (lat - ex.lat) * mLat) < ex.r)) continue;
      let u = 0;
      let v = 0;
      for (const q of tileRing) {
        u += q.x;
        v += q.y;
      }
      const color = colourOf(p.colour, rand);
      items.push({ rings, cx, cz, lat, lon, u: u / tileRing.length / E, v: v / tileRing.length / E, minH, top, footprint, color });
    }
  }
  if (!items.length) return { count: 0 };

  // 2. upper tiers ride on what they stand on
  const host = hosts(items);
  const rootOf = (b) => {
    let r = b;
    for (let k = 0; k < 16 && host[r] >= 0; k++) r = host[r];
    return r;
  };

  // 3. the far set — what reads from kilometres away, and everything it stands on — goes first
  const lod = items.map((it) => it.top >= LOD_TOP || it.footprint >= LOD_AREA);
  for (let b = 0; b < items.length; b++) if (lod[b]) for (let r = host[b], k = 0; r >= 0 && k < 16; r = host[r], k++) lod[r] = true;
  const order = [];
  for (let b = 0; b < items.length; b++) if (lod[b]) order.push(b);
  const lodCount = order.length;
  if (level === 'near') for (let b = 0; b < items.length; b++) if (!lod[b]) order.push(b);
  if (!order.length) return { count: 0, lodCount: 0 };

  // 4. extrude, in that order
  const pos = [];
  const nor = [];
  const col = [];
  const bld = [];
  const idx = [];
  const centroid = new Float64Array(order.length * 2);
  const xz = new Float32Array(order.length * 2);
  const ground = new Float32Array(order.length);
  let lodIndexCount = 0;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  let maxTop = 0;
  order.forEach((b, i) => {
    const it = items[b];
    const root = items[rootOf(b)];
    centroid[i * 2] = root.lat;
    centroid[i * 2 + 1] = root.lon;
    xz[i * 2] = root.cx;
    xz[i * 2 + 1] = root.cz;
    ground[i] = dem ? demAt(dem, root.u, root.v) : NaN;
    maxTop = Math.max(maxTop, it.top);
    const c = it.color;
    const y0 = it.minH > 0 ? it.minH : -6; // walls run on into the ground: no gaps on slopes

    // walls
    for (const ring of it.rings) {
      for (let k = 0; k < ring.length; k++) {
        const [ax, az] = ring[k];
        const [bx, bz] = ring[(k + 1) % ring.length];
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        const nx = dz / len;
        const nz = -dx / len;
        const v = pos.length / 3;
        pos.push(ax, y0, az, bx, y0, bz, bx, it.top, bz, ax, it.top, az);
        for (let q = 0; q < 4; q++) {
          nor.push(Math.round(nx * 127), 0, Math.round(nz * 127));
          // a touch darker at the foot (ambient occlusion on the cheap)
          const s = q < 2 ? 0.78 : 1.0;
          col.push(c[0] * s, c[1] * s, c[2] * s);
          bld.push(i);
        }
        idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
      }
    }

    // roof
    const flat = [];
    const holes = [];
    for (let h = 0; h < it.rings.length; h++) {
      if (h) holes.push(flat.length / 2);
      for (const [px, pz] of it.rings[h]) flat.push(px, pz);
    }
    const tri = Earcut.triangulate(flat, holes, 2);
    const v0 = pos.length / 3;
    for (let k = 0; k < flat.length; k += 2) {
      pos.push(flat[k], it.top, flat[k + 1]);
      nor.push(0, 127, 0);
      col.push(c[0] * 0.74, c[1] * 0.74, c[2] * 0.76);
      bld.push(i);
    }
    for (let k = 0; k < tri.length; k += 3) {
      const i0 = tri[k];
      const i1 = tri[k + 1];
      const i2 = tri[k + 2];
      // face up: in (x, z) the triangle must turn clockwise
      const cr = (flat[i1 * 2] - flat[i0 * 2]) * (flat[i2 * 2 + 1] - flat[i0 * 2 + 1]) - (flat[i1 * 2 + 1] - flat[i0 * 2 + 1]) * (flat[i2 * 2] - flat[i0 * 2]);
      if (cr > 0) idx.push(v0 + i0, v0 + i2, v0 + i1);
      else idx.push(v0 + i0, v0 + i1, v0 + i2);
    }
    for (const [px, pz] of it.rings[0]) {
      x0 = Math.min(x0, px);
      z0 = Math.min(z0, pz);
      x1 = Math.max(x1, px);
      z1 = Math.max(z1, pz);
    }
    if (i === lodCount - 1) lodIndexCount = idx.length;
  });

  const color = new Uint8Array(col.length);
  for (let k = 0; k < col.length; k++) color[k] = Math.round(Math.min(1, col[k]) * 255);
  return {
    count: order.length,
    lodCount,
    lodIndexCount,
    bounds: [x0, z0, x1, z1, maxTop],
    position: new Float32Array(pos),
    normal: new Int8Array(nor),
    color,
    bld: new Uint16Array(bld),
    index: new Uint32Array(idx),
    centroid,
    xz,
    ground,
  };
}

/**
 * For each part that starts above the ground, the part directly beneath it:
 * lower base, roof within a few metres of this base, footprint around this
 * centroid. -1 where there is none. Bases strictly decrease along a chain.
 */
function hosts(items) {
  const CELL = 64;
  const grid = new Map();
  items.forEach((it, b) => {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const [x, z] of it.rings[0]) {
      x0 = Math.min(x0, x);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      z1 = Math.max(z1, z);
    }
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
      for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
        const k = `${gx},${gz}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(b);
      }
    }
  });
  const host = new Int32Array(items.length).fill(-1);
  items.forEach((it, b) => {
    if (it.minH < 0.5) return;
    let gap = 3;
    for (const c of grid.get(`${Math.floor(it.cx / CELL)},${Math.floor(it.cz / CELL)}`) ?? []) {
      const o = items[c];
      const d = Math.abs(o.top - it.minH);
      if (o.minH >= it.minH || d > gap || !inside(o.rings[0], it.cx, it.cz)) continue;
      gap = d;
      host[b] = c;
    }
  });
  return host;
}

function inside(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Shoelace area in (x, z). */
function area(r) {
  let a = 0;
  for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += r[j][0] * r[k][1] - r[k][0] * r[j][1];
  return a / 2;
}

/** Sutherland–Hodgman against [0, E]² (rings arrive closed: drop the repeat). */
function clip(ring, E) {
  let pts = ring.map((p) => ({ x: p.x, y: p.y }));
  if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
  const edges = [
    (p) => p.x >= 0,
    (p) => p.x <= E,
    (p) => p.y >= 0,
    (p) => p.y <= E,
  ];
  const cut = [
    (a, b) => lerpAt(a, b, (0 - a.x) / (b.x - a.x)),
    (a, b) => lerpAt(a, b, (E - a.x) / (b.x - a.x)),
    (a, b) => lerpAt(a, b, (0 - a.y) / (b.y - a.y)),
    (a, b) => lerpAt(a, b, (E - a.y) / (b.y - a.y)),
  ];
  for (let e = 0; e < 4 && pts.length; e++) {
    const inside = edges[e];
    const out = [];
    for (let k = 0; k < pts.length; k++) {
      const cur = pts[k];
      const prev = pts[(k + pts.length - 1) % pts.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut[e](prev, cur));
        out.push(cur);
      } else if (pi) out.push(cut[e](prev, cur));
    }
    pts = out;
  }
  return pts;
}

function lerpAt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** OSM building colour (OpenMapTiles `colour`), toned toward concrete, in linear RGB. */
function colourOf(hex, rand) {
  let r = 0.74;
  let g = 0.72;
  let b = 0.68;
  if (typeof hex === 'string' && /^#?[0-9a-f]{6}$/i.test(hex)) {
    const v = parseInt(hex.replace('#', ''), 16);
    r = 0.5 * r + 0.5 * (((v >> 16) & 255) / 255);
    g = 0.5 * g + 0.5 * (((v >> 8) & 255) / 255);
    b = 0.5 * b + 0.5 * ((v & 255) / 255);
  }
  const j = 0.82 + rand() * 0.3;
  const warm = (rand() - 0.5) * 0.06;
  return [(r + warm) * j, g * j, (b - warm) * j].map((c) => Math.pow(Math.max(0, c), 2.2));
}
