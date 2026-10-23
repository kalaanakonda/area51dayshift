import { DEG, greatCircle } from '../geo.js';

/**
 * Bottom-left moving map: heading-up satellite imagery (Esri World Imagery)
 * with place labels, the craft at the centre, Hangar 9 and the waypoint as
 * markers (pinned to the rim when off the map). Zoom follows altitude.
 *
 * Tiles are plain <img> draws on a 2D canvas (never read back), so they need
 * no CORS; missing tiles fall back to a scaled-up ancestor while they load.
 */
export const IMAGERY = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const LABELS = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;
export const T = 256;
const MPP0 = 156543.03392; // m/px at zoom 0 on the equator

export class TileCache {
  constructor(url, maxZoom, limit = 360) {
    this.url = url;
    this.maxZoom = maxZoom;
    this.map = new Map();
    this.limit = limit;
    this.inflight = 0;
    this.queue = [];
    this.onLoad = null; // called when any tile arrives (the world map redraws on demand)
  }

  get(z, x, y, want = true) {
    const k = `${z}/${x}/${y}`;
    let e = this.map.get(k);
    if (e) {
      e.used = performance.now();
      return e.ok ? e.img : null;
    }
    if (!want) return null;
    e = { img: new Image(), ok: false, used: performance.now(), k, z, x, y };
    this.map.set(k, e);
    this.queue.push(e);
    this._pump();
    this._evict();
    return null;
  }

  _pump() {
    while (this.inflight < 8 && this.queue.length) {
      const e = this.queue.pop(); // newest first: what you need now
      this.inflight++;
      e.img.decoding = 'async';
      e.img.onload = () => {
        e.ok = true;
        this.inflight--;
        this._pump();
        if (this.onLoad) this.onLoad();
      };
      e.img.onerror = () => {
        this.inflight--;
        this._pump();
      };
      e.img.src = this.url(e.z, e.x, e.y);
    }
    // stale requests beyond 48 are dropped (they'll be re-asked if still needed)
    if (this.queue.length > 48) for (const e of this.queue.splice(0, this.queue.length - 48)) this.map.delete(e.k);
  }

  _evict() {
    if (this.map.size <= this.limit) return;
    const arr = [...this.map.values()].sort((a, b) => a.used - b.used);
    for (let i = 0; i < arr.length - this.limit; i++) this.map.delete(arr[i].k);
  }
}

export function worldPx(lat, lon, z) {
  const n = T * 2 ** z;
  const s = Math.min(0.9999, Math.max(-0.9999, Math.sin(lat * DEG)));
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

export class Minimap {
  constructor(el) {
    this.el = el;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    el.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.imagery = new TileCache(IMAGERY, 18);
    this.labels = new TileCache(LABELS, 13, 160);
    this.radius = 1500; // metres shown from centre to rim (smoothed)
    this.size = 0;
    this._acc = 0;
  }

  _resize() {
    const css = this.el.clientWidth || 200;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (px !== this.size) {
      this.size = px;
      this.canvas.width = this.canvas.height = px;
      this.dpr = dpr;
    }
  }

  /** d = { lat, lon, heading (deg), agl, speed, home, wp } */
  update(dt, d) {
    this._acc += dt;
    const want = Math.min(4.0e6, Math.max(900, d.agl * 2.4 + d.speed * 18 + 600));
    this.radius *= Math.exp((Math.log(want) - Math.log(this.radius)) * Math.min(1, dt * 2.5));
    if (this._acc < 1 / 24) return;
    this._acc = 0;
    this._resize();
    this.draw(d);
  }

  draw(d) {
    const g = this.g;
    const S = this.size;
    const dpr = this.dpr;
    const c = S / 2;
    const rim = 10 * dpr;
    const R = c - rim; // map disc radius (device px)
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);

    const lat = d.lat;
    const coslat = Math.max(0.05, Math.cos(lat * DEG));
    const mpp = this.radius / R; // metres per device px
    let z = Math.round(Math.log2((MPP0 * coslat) / mpp));
    z = Math.max(1, Math.min(this.imagery.maxZoom, z));
    const k = (MPP0 * coslat) / 2 ** z / mpp; // device px per tile px
    const [px, py] = worldPx(lat, d.lon, z);
    const hdg = d.heading * DEG;

    g.save();
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#0a1012';
    g.fillRect(0, 0, S, S);
    g.translate(c, c);
    g.rotate(-hdg);
    const span = Math.ceil((R * 1.42) / k / T) + 1;
    const tx0 = Math.floor(px / T);
    const ty0 = Math.floor(py / T);
    const n = 2 ** z;
    for (const layer of [this.imagery, this.labels]) {
      if (layer === this.labels && z > layer.maxZoom + 3) continue;
      const lz = Math.min(z, layer.maxZoom);
      for (let dy = -span; dy <= span; dy++) {
        for (let dx = -span; dx <= span; dx++) {
          const ty = ty0 + dy;
          if (ty < 0 || ty >= n) continue;
          const tx = tx0 + dx;
          const wx = ((tx % n) + n) % n;
          const x = (tx * T - px) * k;
          const y = (ty * T - py) * k;
          const sz = T * k;
          if (Math.hypot(x + sz / 2, y + sz / 2) > R + sz) continue;
          this._tile(layer, lz, z, wx, ty, x, y, sz, layer === this.imagery);
        }
      }
      if (layer === this.imagery) {
        // darken + cool the photo so markers read
        g.fillStyle = 'rgba(6,14,14,0.32)';
        g.fillRect(-S, -S, S * 2, S * 2);
      }
    }
    g.restore();

    // range rings
    g.strokeStyle = 'rgba(155,242,195,0.16)';
    g.lineWidth = 1 * dpr;
    for (const f of [0.5]) {
      g.beginPath();
      g.arc(c, c, R * f, 0, Math.PI * 2);
      g.stroke();
    }

    // markers
    const mark = (p, kind) => {
      const gc = greatCircle(lat * DEG, d.lon * DEG, p.lat * DEG, p.lon * DEG);
      const a = gc.bearing * DEG - hdg;
      let r = gc.dist / mpp;
      const off = r > R - 8 * dpr;
      if (off) r = R - 8 * dpr;
      const x = c + Math.sin(a) * r;
      const y = c - Math.cos(a) * r;
      g.save();
      g.translate(x, y);
      if (kind === 'home') {
        g.fillStyle = '#ffbf5e';
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.lineWidth = 2 * dpr;
        g.beginPath();
        g.moveTo(-5 * dpr, 4 * dpr);
        g.lineTo(-5 * dpr, -2 * dpr);
        g.lineTo(0, -6 * dpr);
        g.lineTo(5 * dpr, -2 * dpr);
        g.lineTo(5 * dpr, 4 * dpr);
        g.closePath();
        g.stroke();
        g.fill();
      } else {
        g.rotate(Math.PI / 4);
        g.fillStyle = '#9bf2c3';
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.lineWidth = 2 * dpr;
        g.strokeRect(-4.5 * dpr, -4.5 * dpr, 9 * dpr, 9 * dpr);
        g.fillRect(-4.5 * dpr, -4.5 * dpr, 9 * dpr, 9 * dpr);
      }
      g.restore();
      if (off) {
        // chevron outside the disc pointing the way
        g.save();
        g.translate(c + Math.sin(a) * (R + 4.5 * dpr), c - Math.cos(a) * (R + 4.5 * dpr));
        g.rotate(a);
        g.fillStyle = kind === 'home' ? '#ffbf5e' : '#9bf2c3';
        g.beginPath();
        g.moveTo(0, -4 * dpr);
        g.lineTo(4 * dpr, 2 * dpr);
        g.lineTo(-4 * dpr, 2 * dpr);
        g.closePath();
        g.fill();
        g.restore();
      }
    };
    if (d.home) mark(d.home, 'home');
    if (d.wp) mark(d.wp, 'wp');

    // bezel: ticks every 10°, cardinal letters, all rotating with the map
    g.save();
    g.translate(c, c);
    g.rotate(-hdg);
    for (let a = 0; a < 360; a += 10) {
      const big = a % 90 === 0;
      const r0 = R + (big ? 1 : 3) * dpr;
      g.strokeStyle = big ? 'rgba(232,239,233,0.9)' : 'rgba(232,239,233,0.35)';
      g.lineWidth = (big ? 1.6 : 1) * dpr;
      g.beginPath();
      g.moveTo(Math.sin(a * DEG) * r0, -Math.cos(a * DEG) * r0);
      g.lineTo(Math.sin(a * DEG) * (R + 8 * dpr), -Math.cos(a * DEG) * (R + 8 * dpr));
      g.stroke();
    }
    g.restore();
    g.font = `600 ${11 * dpr}px "Chakra Petch", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const [l, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const aa = a * DEG - hdg;
      const r = R - 11 * dpr;
      const x = c + Math.sin(aa) * r;
      const y = c - Math.cos(aa) * r;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.beginPath();
      g.arc(x, y, 8 * dpr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = l === 'N' ? '#ffbf5e' : 'rgba(232,239,233,0.85)';
      g.fillText(l, x, y + 0.5 * dpr);
    }

    // craft (fixed, nose up)
    g.save();
    g.translate(c, c);
    g.fillStyle = '#e8efe9';
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.moveTo(0, -9 * dpr);
    g.lineTo(6.5 * dpr, 7 * dpr);
    g.lineTo(0, 3.5 * dpr);
    g.lineTo(-6.5 * dpr, 7 * dpr);
    g.closePath();
    g.stroke();
    g.fill();
    g.restore();

    // scale label (the half ring)
    const half = this.radius / 2;
    g.font = `500 ${10 * dpr}px "IBM Plex Mono", monospace`;
    g.fillStyle = 'rgba(232,239,233,0.8)';
    g.textAlign = 'center';
    const lbl = half >= 1000 ? `${half >= 10000 ? Math.round(half / 1000) : (half / 1000).toFixed(1)} km` : `${Math.round(half)} m`;
    g.fillText(lbl, c, c + R * 0.5 + 9 * dpr);
  }

  _tile(layer, lz, z, x, y, dx, dy, sz, fallback) {
    const g = this.g;
    // labels drawn at a coarser zoom stretch over 2^(z−lz) tiles
    if (lz < z) {
      const f = 2 ** (z - lz);
      const ax = Math.floor(x / f);
      const ay = Math.floor(y / f);
      const img = layer.get(lz, ax, ay);
      if (img) {
        const s = T / f;
        g.drawImage(img, (x % f) * s, (y % f) * s, s, s, dx, dy, sz + 0.5, sz + 0.5);
      }
      return;
    }
    const img = layer.get(z, x, y);
    if (img) {
      g.drawImage(img, dx, dy, sz + 0.5, sz + 0.5);
      return;
    }
    if (!fallback) return;
    for (let up = 1; up <= 5 && z - up >= 0; up++) {
      const f = 2 ** up;
      const a = layer.get(z - up, Math.floor(x / f), Math.floor(y / f), up === 3);
      if (a) {
        const s = T / f;
        g.drawImage(a, (x % f) * s, (y % f) * s, s, s, dx, dy, sz + 0.5, sz + 0.5);
        return;
      }
    }
  }
}
