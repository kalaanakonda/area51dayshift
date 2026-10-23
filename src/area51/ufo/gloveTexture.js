import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import { normalFromHeight } from '../textures.js';
import { mulberry32 } from '../../core/math.js';

/**
 * Flight-glove textures painted straight into a rigged hand's UV layout
 * (GS/FRP-2 style: sage Nomex back, grey-tan goatskin palm and finger fronts).
 *
 * The layout is read from the mesh: UV islands (back / palm / wrist cap) come
 * from triangle connectivity, finger and phalanx from each vertex's dominant
 * bone. So the seams run where the palm and back panels really meet (the UV
 * cut along each finger), knuckle pads sit on the MCP line, creases on every
 * joint line, and the fingertips wear shiny.
 */
const S = 1024;

function boneInfo(name) {
  const finger = /thumb/.test(name) ? 0 : /index/.test(name) ? 1 : /middle/.test(name) ? 2 : /ring/.test(name) ? 3 : /pinky/.test(name) ? 4 : -1;
  const seg = /metacarpal/.test(name) ? 0 : /proximal/.test(name) ? 1 : /intermediate/.test(name) ? 2 : /distal/.test(name) ? 3 : /tip/.test(name) ? 3 : 0;
  return { finger, seg };
}

export function gloveTextures(mesh, palmSign = 1) {
  const geo = mesh.geometry;
  const uv = geo.attributes.uv;
  const nor = geo.attributes.normal;
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const idx = geo.index.array;
  const nTri = idx.length / 3;
  const bones = mesh.skeleton.bones.map((b) => boneInfo(b.name));
  const rand = mulberry32(77);

  const dom = new Int16Array(uv.count);
  for (let i = 0; i < uv.count; i++) {
    let best = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > best) {
        best = w;
        dom[i] = si.getComponent(i, k);
      }
    }
  }
  // islands: union-find over shared vertices
  const parent = new Int32Array(uv.count).map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let t = 0; t < nTri; t++) {
    const a = find(idx[t * 3]);
    parent[find(idx[t * 3 + 1])] = a;
    parent[find(idx[t * 3 + 2])] = a;
  }
  const isl = new Map();
  for (let t = 0; t < nTri; t++) {
    const r = find(idx[t * 3]);
    if (!isl.has(r)) isl.set(r, { tris: [], nx: 0 });
    const I = isl.get(r);
    I.tris.push(t);
    for (let k = 0; k < 3; k++) I.nx += nor.getX(idx[t * 3 + k]) * palmSign;
  }
  const islands = [...isl.values()].sort((a, b) => b.tris.length - a.tris.length);
  // two big islands: whichever faces along the palm normal is the palm
  const kind = new Uint8Array(nTri); // 0 back, 1 palm, 2 cap
  islands.forEach((I, n) => {
    const k = n > 1 ? 2 : I.nx > 0 ? 1 : 0;
    for (const t of I.tris) kind[t] = k;
  });
  const triBone = new Int16Array(nTri);
  for (let t = 0; t < nTri; t++) {
    // majority bone of the three corners
    const a = dom[idx[t * 3]];
    const b = dom[idx[t * 3 + 1]];
    const c = dom[idx[t * 3 + 2]];
    triBone[t] = a === b || a === c ? a : b === c ? b : a;
  }
  const P = (i) => [uv.getX(i) * S, (1 - uv.getY(i)) * S];

  // edges: boundary (seams) and joint lines (bone changes inside an island)
  const edges = new Map();
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k];
      const b = idx[t * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const e = edges.get(key);
      if (e) e.t2 = t;
      else edges.set(key, { a, b, t1: t, t2: -1, c: idx[t * 3 + ((k + 2) % 3)] });
    }
  }
  const seams = [];
  const joints = [];
  const knuckles = [];
  for (const e of edges.values()) {
    if (e.t2 < 0) {
      if (kind[e.t1] !== 2) seams.push(e);
      continue;
    }
    const A = bones[triBone[e.t1]];
    const B = bones[triBone[e.t2]];
    if (A.finger !== B.finger || A.seg === B.seg || A.finger < 0) continue;
    const seg = Math.max(A.seg, B.seg);
    if (seg === 1 && A.finger > 0 && kind[e.t1] === 0) knuckles.push(e);
    else joints.push({ ...e, palm: kind[e.t1] === 1 });
  }

  const canvas = (fill) => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = fill;
    g.fillRect(0, 0, S, S);
    return [c, g];
  };
  const [cc, g] = canvas('#5f6150');
  const [hc, h] = canvas('#808080');
  const [rc, r] = canvas('#d0d0d0');
  const triPath = (filter) => {
    const p = new Path2D();
    for (let t = 0; t < nTri; t++) {
      if (!filter(t)) continue;
      const [x0, y0] = P(idx[t * 3]);
      const [x1, y1] = P(idx[t * 3 + 1]);
      const [x2, y2] = P(idx[t * 3 + 2]);
      p.moveTo(x0, y0);
      p.lineTo(x1, y1);
      p.lineTo(x2, y2);
      p.closePath();
    }
    return p;
  };
  const fillRegion = (ctx, path, col, dilate = 3) => {
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.lineWidth = dilate;
    ctx.lineJoin = 'round';
    ctx.fill(path);
    ctx.stroke(path);
  };
  const back = triPath((t) => kind[t] === 0);
  const palm = triPath((t) => kind[t] !== 0);
  const tips = triPath((t) => kind[t] === 1 && bones[triBone[t]].seg === 3);

  // base colours
  fillRegion(g, back, '#5d6249');
  fillRegion(g, palm, '#6c6152');
  fillRegion(r, back, '#dadada'); // Nomex: matte
  fillRegion(r, palm, '#8f8f8f'); // goatskin: satin
  // fabric weave (back) and leather grain (palm)
  const weave = document.createElement('canvas');
  weave.width = weave.height = 64;
  {
    const w = weave.getContext('2d');
    const d = w.createImageData(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const v = 128 + Math.sin(((x + y) / 64) * Math.PI * 2 * 16) * 34 + (rand() - 0.5) * 40;
        const i = (y * 64 + x) * 4;
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
        d.data[i + 3] = 255;
      }
    }
    w.putImageData(d, 0, 0);
  }
  const grain = document.createElement('canvas');
  grain.width = grain.height = 128;
  {
    const w = grain.getContext('2d');
    w.fillStyle = '#808080';
    w.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 900; i++) {
      w.fillStyle = `rgba(${rand() < 0.5 ? '255,255,255' : '0,0,0'},${0.05 + rand() * 0.12})`;
      w.beginPath();
      w.arc(rand() * 128, rand() * 128, 0.8 + rand() * 2.2, 0, Math.PI * 2);
      w.fill();
    }
  }
  const pattern = (ctx, path, img, alpha, op) => {
    ctx.save();
    ctx.clip(path);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
    ctx.fillStyle = ctx.createPattern(img, 'repeat');
    ctx.fillRect(0, 0, S, S);
    ctx.restore();
  };
  pattern(g, back, weave, 0.22, 'overlay');
  pattern(g, palm, grain, 0.35, 'overlay');
  pattern(h, back, weave, 0.55, 'source-over');
  pattern(h, palm, grain, 0.7, 'source-over');

  // worn, polished fingertips and palm heel
  g.save();
  g.clip(tips);
  g.fillStyle = 'rgba(170,160,145,0.18)';
  g.fillRect(0, 0, S, S);
  g.restore();
  fillRegion(r, tips, '#707070', 2);

  // grime: soft dark blotches near creases, lighter scuffs
  for (let i = 0; i < 140; i++) {
    const t = Math.floor(rand() * nTri);
    const [x, y] = P(idx[t * 3]);
    const rad = 6 + rand() * 26;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    const dark = rand() < 0.6;
    gr.addColorStop(0, dark ? 'rgba(20,18,14,0.16)' : 'rgba(200,195,180,0.08)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }

  const strokeEdges = (ctx, list, w, col) => {
    ctx.save();
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.strokeStyle = col;
    ctx.beginPath();
    for (const e of list) {
      const [x0, y0] = P(e.a);
      const [x1, y1] = P(e.b);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.restore();
  };
  const offsetEdges = (list, d) =>
    list.map((e) => {
      const [x0, y0] = P(e.a);
      const [x1, y1] = P(e.b);
      const [cx, cy] = P(e.c);
      let nx = -(y1 - y0);
      let ny = x1 - x0;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      if ((cx - x0) * nx + (cy - y0) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      return [x0 + nx * d, y0 + ny * d, x1 + nx * d, y1 + ny * d];
    });
  const strokeSegs = (ctx, segs, w, col, dash) => {
    ctx.save();
    ctx.lineWidth = w;
    ctx.strokeStyle = col;
    ctx.lineCap = 'butt';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of segs) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.restore();
  };
  // Joint lines follow the triangle boundary between two phalanges, which zigzags;
  // fit each joint (per finger, per side) with a straight axis and paint along that instead.
  const groups = new Map();
  for (const e of [...joints, ...knuckles.map((k) => ({ ...k, palm: false, pad: true }))]) {
    const A = bones[triBone[e.t1]];
    const B = bones[triBone[e.t2]];
    const key = `${A.finger}:${Math.max(A.seg, B.seg)}:${e.palm ? 1 : 0}:${e.pad ? 1 : 0}`;
    if (!groups.has(key)) groups.set(key, { pts: [], palm: e.palm, pad: !!e.pad });
    const [x0, y0] = P(e.a);
    const [x1, y1] = P(e.b);
    groups.get(key).pts.push([(x0 + x1) / 2, (y0 + y1) / 2]);
  }
  const fit = (pts) => {
    let cx = 0;
    let cy = 0;
    for (const [x, y] of pts) {
      cx += x;
      cy += y;
    }
    cx /= pts.length;
    cy /= pts.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const [x, y] of pts) {
      sxx += (x - cx) ** 2;
      sxy += (x - cx) * (y - cy);
      syy += (y - cy) ** 2;
    }
    const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, y] of pts) {
      const t = (x - cx) * Math.cos(a) + (y - cy) * Math.sin(a);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    return { cx: cx + Math.cos(a) * (lo + hi) * 0.5, cy: cy + Math.sin(a) * (lo + hi) * 0.5, a, len: Math.max(14, hi - lo) };
  };
  for (const G of groups.values()) {
    const { cx, cy, a, len } = fit(G.pts);
    const clip = G.palm ? palm : back;
    if (G.pad) {
      // padded knuckle oval with its own stitching
      for (const [ctx, fillC, stitch] of [[g, '#4f5341', 'rgba(178,170,140,0.9)'], [h, '#cfcfcf', '#f0f0f0']]) {
        ctx.save();
        ctx.clip(clip);
        ctx.translate(cx, cy);
        ctx.rotate(a);
        ctx.filter = ctx === h ? 'blur(3px)' : 'none';
        ctx.fillStyle = fillC;
        ctx.beginPath();
        ctx.ellipse(0, 0, len * 0.5 + 4, 15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.filter = 'none';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = ctx === h ? 2.6 : 2;
        ctx.strokeStyle = stitch;
        ctx.beginPath();
        ctx.ellipse(0, 0, len * 0.5, 11, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      continue;
    }
    // soft crease: a dark fold, a lit lip on one side, a groove in the height
    for (const [ctx, col, w, blur, off] of [[g, 'rgba(24,22,17,0.5)', 4, 2, 0], [g, 'rgba(215,208,190,0.16)', 3, 2, 4], [h, '#383838', 7, 3, 0]]) {
      ctx.save();
      ctx.clip(clip);
      ctx.translate(cx, cy);
      ctx.rotate(a);
      ctx.filter = `blur(${blur}px)`;
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-len * 0.46, off);
      ctx.quadraticCurveTo(0, off + (G.palm ? 3 : -3), len * 0.46, off);
      ctx.stroke();
      ctx.restore();
    }
  }

  // seams where palm and back panels meet: a welt, and a stitch line just inside each panel
  for (const ctx of [g, h]) {
    const seamCol = ctx === g ? 'rgba(22,22,18,0.85)' : '#2a2a2a';
    strokeEdges(ctx, seams, 5, seamCol);
  }
  const inside = offsetEdges(seams, 7);
  strokeSegs(g, inside, 2.4, 'rgba(186,178,150,0.95)', [6, 4]);
  strokeSegs(h, inside, 3.2, '#ececec', [6, 4]);
  // a small woven label on the back of the wrist
  {
    const wb = islands[0].tris.length && [...edges.values()].length;
    let wx = 0;
    let wy = 0;
    let n = 0;
    for (let t = 0; t < nTri; t++) {
      if (kind[t] === 0 && bones[triBone[t]].finger < 0) {
        const [x, y] = P(idx[t * 3]);
        wx += x;
        wy += y;
        n++;
      }
    }
    if (n && wb) {
      wx /= n;
      wy /= n;
      g.save();
      g.clip(back);
      g.translate(wx, wy);
      g.rotate(-0.5);
      g.fillStyle = '#2b2c26';
      g.fillRect(-34, -11, 68, 22);
      g.font = '700 12px "IBM Plex Mono", monospace';
      g.fillStyle = 'rgba(205,200,180,0.9)';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('GS/FRP-2', 0, 1);
      g.restore();
    }
  }

  const map = new CanvasTexture(cc);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 8;
  map.minFilter = LinearMipmapLinearFilter;
  map.magFilter = LinearFilter;
  const roughnessMap = new CanvasTexture(rc);
  roughnessMap.anisotropy = 8;
  const hd = h.getImageData(0, 0, S, S).data;
  const hf = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) hf[i] = hd[i * 4] / 255;
  const normalMap = normalFromHeight(hf, S, S, 2.2, { topDown: true });
  return { map, normalMap, roughnessMap };
}
