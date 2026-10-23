import { DEG, greatCircle } from '../geo.js';
import { IMAGERY, LABELS, T, TileCache } from './Minimap.js';
import { Warp } from '../ufo/Warp.js';
import { fmtDist } from './Hud.js';

/**
 * Full-screen nav map (M). North-up Web Mercator over Esri World Imagery with
 * place labels. Drag to pan, wheel / pinch to zoom, click to drop a pin, or
 * search a place (OpenStreetMap Nominatim, only when you press Find). The
 * pin becomes the warp destination and the HUD waypoint.
 */
export const PLACES = [
  { name: 'Hangar 9 · Groom Lake', lat: 37.2549, lon: -115.8171, home: true },
  { name: 'Las Vegas Strip', lat: 36.1147, lon: -115.1728 },
  { name: 'Hoover Dam', lat: 36.016, lon: -114.7377 },
  { name: 'Grand Canyon', lat: 36.0617, lon: -112.1077 },
  { name: 'Golden Gate Bridge', lat: 37.8199, lon: -122.4783 },
  { name: 'Manhattan', lat: 40.7484, lon: -73.9857 },
  { name: 'Niagara Falls', lat: 43.0799, lon: -79.0747 },
  { name: 'Christ the Redeemer', lat: -22.9519, lon: -43.2105 },
  { name: 'Machu Picchu', lat: -13.1631, lon: -72.545, alt: 5200 },
  { name: 'Eiffel Tower', lat: 48.8584, lon: 2.2945 },
  { name: 'Big Ben, London', lat: 51.5007, lon: -0.1246 },
  { name: 'Colosseum, Rome', lat: 41.8902, lon: 12.4922 },
  { name: 'Pyramids of Giza', lat: 29.9792, lon: 31.1342 },
  { name: 'Burj Khalifa, Dubai', lat: 25.1972, lon: 55.2744 },
  { name: 'Taj Mahal', lat: 27.1751, lon: 78.0421 },
  { name: 'Mount Everest', lat: 27.9881, lon: 86.925, alt: 11000 },
  { name: 'Mount Fuji', lat: 35.3606, lon: 138.7274, alt: 6000 },
  { name: 'Tokyo Tower', lat: 35.6586, lon: 139.7454 },
  { name: 'Sydney Opera House', lat: -33.8568, lon: 151.2153 },
  { name: 'Kilimanjaro', lat: -3.0674, lon: 37.3556, alt: 8000 },
];

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const MAXLAT = 85.0511;

function toMerc(lat, lon) {
  const l = Math.max(-MAXLAT, Math.min(MAXLAT, lat)) * DEG;
  return { x: (lon + 180) / 360, y: 0.5 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / (2 * Math.PI) };
}

function fromMerc(x, y) {
  const lon = (((x % 1) + 1) % 1) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
  return { lat, lon };
}

const html = String.raw;

export class WorldMap {
  /** handlers: onWarp(dest) → {ok, reason}, onWaypoint(dest), onClose(relock) */
  constructor(parent, handlers) {
    this.h = handlers;
    const el = document.createElement('div');
    el.className = 'wmap';
    el.hidden = true;
    el.tabIndex = -1; // holds focus so Enter / M / Esc reach the map, not the game
    el.innerHTML = html`
      <canvas class="wmap-canvas" aria-label="World map — click to set a destination"></canvas>
      <header class="wmap-top">
        <div class="wmap-title"><b>NAV · WORLD</b><span>Click anywhere to drop a destination pin</span></div>
        <button type="button" class="wmap-close" data-close><kbd>M</kbd> Close</button>
      </header>
      <aside class="wmap-side">
        <form class="wmap-search" data-search>
          <input type="search" name="q" placeholder="Search a place — city, landmark, address" autocomplete="off" spellcheck="false" />
          <button type="submit">Find</button>
        </form>
        <div class="wmap-results" data-results></div>
        <section class="wmap-sel" data-sel hidden>
          <div class="k">DESTINATION</div>
          <div class="name" data-name></div>
          <div class="sub" data-sub></div>
          <div class="facts">
            <div><b>DIST</b><span data-dist></span></div>
            <div><b>BRG</b><span data-brg></span></div>
            <div><b>WARP</b><span data-eta></span></div>
          </div>
          <button type="button" class="warp" data-warp>Engage warp <kbd>⏎</kbd></button>
          <button type="button" class="ghost" data-wp>Set as waypoint · fly it yourself</button>
          <div class="why" data-why></div>
        </section>
        <section class="wmap-marks">
          <div class="k">BOOKMARKS</div>
          <div class="chips" data-marks></div>
        </section>
      </aside>
      <div class="wmap-zoom">
        <button type="button" data-zin aria-label="Zoom in">+</button>
        <button type="button" data-zout aria-label="Zoom out">−</button>
        <button type="button" data-me aria-label="Centre on ARV-3">◎</button>
      </div>
      <div class="wmap-attrib">Imagery © Esri, Maxar, Earthstar Geographics · Labels © Esri · Search © OpenStreetMap contributors</div>
    `;
    parent.appendChild(el);
    this.el = el;
    const q = (s) => el.querySelector(s);
    this.canvas = q('.wmap-canvas');
    this.g = this.canvas.getContext('2d');
    this.ui = {
      results: q('[data-results]'),
      sel: q('[data-sel]'),
      name: q('[data-name]'),
      sub: q('[data-sub]'),
      dist: q('[data-dist]'),
      brg: q('[data-brg]'),
      eta: q('[data-eta]'),
      warp: q('[data-warp]'),
      wp: q('[data-wp]'),
      why: q('[data-why]'),
      input: q('[data-search] input'),
    };
    this.imagery = new TileCache(IMAGERY, 18, 500);
    this.labels = new TileCache(LABELS, 13, 220);
    this.imagery.onLoad = this.labels.onLoad = () => (this.dirty = true);
    this.cx = 0.5;
    this.cy = 0.5;
    this.z = 4;
    this.first = true;
    this.sel = null;
    this.ctx = { lat: 0, lon: 0, heading: 0, canWarp: { ok: false, reason: '' } };
    this.dirty = true;
    this._raf = 0;
    this._reverseT = 0;

    // bookmarks
    const marks = q('[data-marks]');
    for (const p of PLACES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = p.home ? 'chip home' : 'chip';
      b.textContent = p.name;
      b.addEventListener('click', () => this.select({ ...p, sub: p.home ? 'Home base' : 'Bookmark' }, true));
      marks.appendChild(b);
    }
    q('[data-close]').addEventListener('click', () => this.h.onClose(true));
    q('[data-zin]').addEventListener('click', () => this.zoomBy(1));
    q('[data-zout]').addEventListener('click', () => this.zoomBy(-1));
    q('[data-me]').addEventListener('click', () => this.flyTo(this.ctx.lat, this.ctx.lon, Math.max(this.z, 6)));
    this.ui.warp.addEventListener('click', () => this.engage());
    this.ui.wp.addEventListener('click', () => {
      if (this.sel) this.h.onWaypoint(this.sel);
    });
    q('[data-search]').addEventListener('submit', (e) => {
      e.preventDefault();
      this.search(this.ui.input.value.trim());
    });
    el.addEventListener('keydown', (e) => {
      const typing = e.target === this.ui.input;
      const onButton = e.target.tagName === 'BUTTON';
      if (e.code === 'Escape') {
        e.preventDefault();
        this.h.onClose(false);
      } else if (!typing && e.code === 'KeyM') this.h.onClose(true);
      else if (!typing && !onButton && e.code === 'Enter') {
        e.preventDefault();
        this.engage();
      } else if (!typing && (e.key === '+' || e.key === '=')) this.zoomBy(1);
      else if (!typing && (e.key === '-' || e.key === '_')) this.zoomBy(-1);
      e.stopPropagation(); // the game's keys stay quiet while the map is up
    });

    // pan / zoom / pick
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.el.focus({ preventScroll: true });
      drag = { x: e.clientX, y: e.clientY, moved: false };
      this.anim = null;
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      const ws = T * 2 ** this.z;
      this.cx -= dx / ws;
      this.cy = Math.max(0, Math.min(1, this.cy - dy / ws));
      drag.x = e.clientX;
      drag.y = e.clientY;
      this.dirty = true;
    });
    c.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        const m = this._screenToMerc(e.offsetX, e.offsetY);
        const ll = fromMerc(m.x, m.y);
        this.select({ name: 'Dropped pin', sub: 'Locating…', lat: ll.lat, lon: ll.lon }, false);
        this._reverse(ll.lat, ll.lon);
      }
      drag = null;
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const dz = -e.deltaY * (e.deltaMode === 1 ? 0.12 : 0.0035);
        this.zoomAt(e.offsetX, e.offsetY, Math.max(-1, Math.min(1, dz)));
      },
      { passive: false }
    );
    c.addEventListener('dblclick', (e) => this.zoomAt(e.offsetX, e.offsetY, 1));
    window.addEventListener('resize', () => (this.dirty = true));
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(ctx) {
    this.ctx = ctx;
    this.el.hidden = false;
    if (this.first) {
      this.first = false;
      const m = toMerc(ctx.lat, ctx.lon);
      this.cx = m.x;
      this.cy = m.y;
      this.z = 5;
    }
    this._refreshSel();
    this.dirty = true;
    this.el.focus({ preventScroll: true });
    const loop = () => {
      if (this.el.hidden) return;
      this._tick();
      this._raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(loop);
  }

  close() {
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
    this.el.hidden = true;
    cancelAnimationFrame(this._raf);
  }

  /** Live craft state while open: { lat, lon, heading, canWarp: {ok, reason}, wp } */
  update(ctx) {
    const moved = Math.abs(ctx.lat - this.ctx.lat) + Math.abs(ctx.lon - this.ctx.lon) > 1e-5 || Math.abs(ctx.heading - this.ctx.heading) > 0.5;
    const warpChanged = ctx.canWarp.ok !== this.ctx.canWarp.ok || ctx.canWarp.reason !== this.ctx.canWarp.reason;
    this.ctx = ctx;
    if (moved) this.dirty = true;
    if (moved || warpChanged) this._refreshSel();
  }

  select(dest, fly) {
    this.sel = dest;
    this._refreshSel();
    if (fly) this.flyTo(dest.lat, dest.lon, dest.zoom ?? Math.max(this.z, 9));
    this.dirty = true;
    // back to the map itself, so Enter engages (a focused chip would re-select)
    if (!this.el.hidden && document.activeElement !== this.ui.input) this.el.focus({ preventScroll: true });
  }

  zoomBy(d) {
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(r.width / 2, r.height / 2, d);
  }

  zoomAt(sx, sy, dz) {
    const before = this._screenToMerc(sx, sy);
    this.z = Math.max(1.6, Math.min(17.5, this.z + dz));
    const after = this._screenToMerc(sx, sy);
    this.cx += before.x - after.x;
    this.cy = Math.max(0, Math.min(1, this.cy + before.y - after.y));
    this.anim = null;
    this.dirty = true;
  }

  flyTo(lat, lon, z) {
    const m = toMerc(lat, lon);
    const tx = m.x + Math.round(this.cx - m.x); // nearest world copy
    this.anim = { x0: this.cx, y0: this.cy, z0: this.z, x1: tx, y1: m.y, z1: z, t: 0 };
  }

  async search(q) {
    const R = this.ui.results;
    if (!q) {
      R.innerHTML = '';
      return;
    }
    R.innerHTML = '<div class="note">Searching…</div>';
    try {
      const r = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=6&accept-language=en&q=${encodeURIComponent(q)}`);
      const list = await r.json();
      R.innerHTML = '';
      if (!list.length) {
        R.innerHTML = '<div class="note">Nothing found — try another name, or click the map.</div>';
        return;
      }
      for (const it of list) {
        const [name, ...rest] = String(it.display_name).split(', ');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'result';
        b.innerHTML = `<b></b><span></span>`;
        b.querySelector('b').textContent = name;
        b.querySelector('span').textContent = rest.slice(0, 3).join(', ');
        b.addEventListener('click', () => {
          const lat = parseFloat(it.lat);
          const lon = parseFloat(it.lon);
          let zoom = 11;
          if (it.boundingbox) {
            const [s, n, w, e] = it.boundingbox.map(parseFloat);
            const a = toMerc(n, w);
            const bb = toMerc(s, e);
            const span = Math.max(Math.abs(bb.x - a.x), Math.abs(bb.y - a.y), 1e-7);
            const view = Math.min(this.canvas.clientWidth, this.canvas.clientHeight) * 0.6;
            zoom = Math.max(3, Math.min(15, Math.log2(view / (span * T))));
          }
          this.select({ name, sub: rest.slice(0, 3).join(', '), lat, lon, zoom }, true);
        });
        R.appendChild(b);
      }
    } catch {
      R.innerHTML = '<div class="note">Search is offline — click the map to drop a pin instead.</div>';
    }
  }

  async _reverse(lat, lon) {
    // Nominatim asks for ≤1 request/s; only the latest click is looked up.
    const id = ++this._reverseT;
    await new Promise((r) => setTimeout(r, 700));
    if (id !== this._reverseT || !this.sel) return;
    try {
      const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
      const j = await r.json();
      if (id !== this._reverseT || !this.sel) return;
      if (j && j.display_name) {
        const parts = String(j.display_name).split(', ');
        this.sel.name = j.name || parts[0];
        this.sel.sub = parts.slice(1, 4).join(', ');
      } else {
        this.sel.name = Math.abs(lat) > 60 ? 'Polar wilderness' : 'Open water';
        this.sel.sub = 'No named place here';
      }
    } catch {
      this.sel.sub = '';
    }
    this._refreshSel();
  }

  /** Engage warp to the pin (Enter, or the button). */
  engage() {
    if (!this.sel) return;
    const r = this.h.onWarp(this.sel);
    if (r && !r.ok) {
      this.ui.why.textContent = r.reason;
      this.ui.why.classList.add('shake');
      setTimeout(() => this.ui.why.classList.remove('shake'), 500);
    }
  }

  _refreshSel() {
    const s = this.sel;
    const U = this.ui;
    U.sel.hidden = !s;
    if (!s) return;
    const g = greatCircle(this.ctx.lat * DEG, this.ctx.lon * DEG, s.lat * DEG, s.lon * DEG);
    U.name.textContent = s.name;
    U.sub.textContent = `${s.sub ? `${s.sub} · ` : ''}${Math.abs(s.lat).toFixed(4)}°${s.lat >= 0 ? 'N' : 'S'} ${Math.abs(s.lon).toFixed(4)}°${s.lon >= 0 ? 'E' : 'W'}`;
    U.dist.textContent = fmtDist(g.dist);
    U.brg.textContent = `${String(Math.round(g.bearing)).padStart(3, '0')}°`;
    U.eta.textContent = g.dist < 1500 ? 'here' : `${Math.round(Warp.eta(g.dist))} s`;
    const can = this.ctx.canWarp;
    U.warp.disabled = !can.ok || g.dist < 1500;
    U.why.textContent = can.ok ? (g.dist < 1500 ? 'You are already here.' : 'Drive charged · press Enter or Engage') : can.reason;
  }

  _screenToMerc(sx, sy) {
    const r = this.canvas.getBoundingClientRect();
    const ws = T * 2 ** this.z;
    return { x: this.cx + (sx - r.width / 2) / ws, y: this.cy + (sy - r.height / 2) / ws };
  }

  _tick() {
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + 1 / 40);
      const k = a.t * a.t * (3 - 2 * a.t);
      this.cx = a.x0 + (a.x1 - a.x0) * k;
      this.cy = a.y0 + (a.y1 - a.y0) * k;
      // zoom out a little in the middle of long hops
      const span = Math.hypot(a.x1 - a.x0, a.y1 - a.y0);
      const dip = Math.min(4, Math.log2(1 + span * 64)) * Math.sin(Math.PI * k);
      this.z = a.z0 + (a.z1 - a.z0) * k - dip;
      if (a.t >= 1) this.anim = null;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this._draw();
  }

  _draw() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const Wc = c.clientWidth;
    const Hc = c.clientHeight;
    if (c.width !== Math.round(Wc * dpr) || c.height !== Math.round(Hc * dpr)) {
      c.width = Math.round(Wc * dpr);
      c.height = Math.round(Hc * dpr);
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#070b0c';
    g.fillRect(0, 0, Wc, Hc);
    const ws = T * 2 ** this.z;
    const zi = Math.max(1, Math.min(this.imagery.maxZoom, Math.floor(this.z + 0.35)));
    const n = 2 ** zi;
    const ts = ws / n;
    const ox = Wc / 2 - this.cx * ws;
    const oy = Hc / 2 - this.cy * ws;
    const tx0 = Math.floor(-ox / ts);
    const tx1 = Math.floor((Wc - ox) / ts);
    const ty0 = Math.max(0, Math.floor(-oy / ts));
    const ty1 = Math.min(n - 1, Math.floor((Hc - oy) / ts));
    for (const layer of [this.imagery, this.labels]) {
      if (layer === this.labels && zi > layer.maxZoom + 3) continue;
      const lz = Math.min(zi, layer.maxZoom);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const wx = ((tx % n) + n) % n;
          drawTile(g, layer, lz, zi, wx, ty, ox + tx * ts, oy + ty * ts, ts, layer === this.imagery);
        }
      }
      if (layer === this.imagery) {
        g.fillStyle = 'rgba(5,12,14,0.16)';
        g.fillRect(0, 0, Wc, Hc);
      }
    }
    // graticule when zoomed out
    if (this.z < 6) {
      g.strokeStyle = 'rgba(155,242,195,0.12)';
      g.lineWidth = 1;
      g.beginPath();
      for (let lon = -180; lon <= 180; lon += 30) {
        for (let k = -1; k <= 1; k++) {
          const x = ox + ((lon + 180) / 360 + k) * ws;
          if (x < -1 || x > Wc + 1) continue;
          g.moveTo(x, Math.max(0, oy));
          g.lineTo(x, Math.min(Hc, oy + ws));
        }
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        const y = oy + toMerc(lat, 0).y * ws;
        g.moveTo(0, y);
        g.lineTo(Wc, y);
      }
      g.stroke();
    }
    const at = (lat, lon) => {
      const m = toMerc(lat, lon);
      const x = m.x + Math.round(this.cx - m.x);
      return [ox + x * ws, oy + m.y * ws];
    };
    // route from the craft to the pin along the great circle
    const C = this.ctx;
    if (this.sel) {
      const pts = greatCirclePoints(C.lat, C.lon, this.sel.lat, this.sel.lon, 128);
      g.save();
      g.setLineDash([7, 6]);
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(155,242,195,0.9)';
      g.shadowColor = 'rgba(0,0,0,0.6)';
      g.shadowBlur = 3;
      g.beginPath();
      let prevX = null;
      const m0 = toMerc(pts[0][0], pts[0][1]);
      const shift = Math.round(this.cx - m0.x);
      pts.forEach(([la, lo], i) => {
        const m = toMerc(la, lo);
        let x = m.x + shift;
        if (prevX != null) x += Math.round(prevX - x);
        prevX = x;
        const sx = ox + x * ws;
        const sy = oy + m.y * ws;
        if (i) g.lineTo(sx, sy);
        else g.moveTo(sx, sy);
      });
      g.stroke();
      g.restore();
    }
    // home
    {
      const [x, y] = at(PLACES[0].lat, PLACES[0].lon);
      house(g, x, y);
    }
    // mission waypoint
    if (C.wp) {
      const [x, y] = at(C.wp.lat, C.wp.lon);
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI / 4);
      g.fillStyle = '#9bf2c3';
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.lineWidth = 2;
      g.strokeRect(-5, -5, 10, 10);
      g.fillRect(-5, -5, 10, 10);
      g.restore();
    }
    // pin
    if (this.sel) {
      const [x, y] = at(this.sel.lat, this.sel.lon);
      const pulse = (performance.now() % 1600) / 1600;
      g.strokeStyle = `rgba(255,191,94,${(1 - pulse).toFixed(3)})`;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, 6 + pulse * 22, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#ffbf5e';
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.beginPath();
      g.moveTo(x, y);
      g.bezierCurveTo(x - 9, y - 12, x - 9, y - 26, x, y - 27);
      g.bezierCurveTo(x + 9, y - 26, x + 9, y - 12, x, y);
      g.fill();
      g.stroke();
      g.fillStyle = '#2a1a05';
      g.beginPath();
      g.arc(x, y - 18, 3.2, 0, Math.PI * 2);
      g.fill();
      this.dirty = true; // keep the pulse going
    }
    // the craft
    {
      const [x, y] = at(C.lat, C.lon);
      g.save();
      g.translate(x, y);
      g.rotate(C.heading * DEG);
      g.fillStyle = '#e8efe9';
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, -11);
      g.lineTo(8, 9);
      g.lineTo(0, 4.5);
      g.lineTo(-8, 9);
      g.closePath();
      g.stroke();
      g.fill();
      g.restore();
      g.font = '600 11px "Chakra Petch", sans-serif';
      g.fillStyle = 'rgba(232,239,233,0.95)';
      g.textAlign = 'left';
      g.fillText('ARV-3', x + 12, y + 4);
    }
    // scale bar
    {
      const lat = fromMerc(this.cx, this.cy).lat;
      const mpp = (40075016.7 * Math.cos(lat * DEG)) / ws;
      const target = 120 * mpp;
      const p = 10 ** Math.floor(Math.log10(target));
      const nice = [1, 2, 5, 10].map((k) => k * p).filter((v) => v <= target).pop() || p;
      const px = nice / mpp;
      const x = 22;
      const y = Hc - 34;
      g.fillStyle = 'rgba(6,10,10,0.6)';
      g.fillRect(x - 6, y - 16, px + 12, 24);
      g.strokeStyle = '#e8efe9';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y - 4);
      g.lineTo(x, y);
      g.lineTo(x + px, y);
      g.lineTo(x + px, y - 4);
      g.stroke();
      g.font = '500 10px "IBM Plex Mono", monospace';
      g.fillStyle = '#e8efe9';
      g.fillText(fmtDist(nice), x + 2, y - 6);
    }
  }
}

function drawTile(g, layer, lz, z, x, y, dx, dy, sz, fallback) {
  if (lz < z) {
    const f = 2 ** (z - lz);
    const img = layer.get(lz, Math.floor(x / f), Math.floor(y / f));
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
  for (let up = 1; up <= 6 && z - up >= 0; up++) {
    const f = 2 ** up;
    const a = layer.get(z - up, Math.floor(x / f), Math.floor(y / f), up === 3);
    if (a) {
      const s = T / f;
      g.drawImage(a, (x % f) * s, (y % f) * s, s, s, dx, dy, sz + 0.5, sz + 0.5);
      return;
    }
  }
}

function house(g, x, y) {
  g.fillStyle = '#ffbf5e';
  g.strokeStyle = 'rgba(0,0,0,0.65)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x - 6, y + 5);
  g.lineTo(x - 6, y - 2);
  g.lineTo(x, y - 8);
  g.lineTo(x + 6, y - 2);
  g.lineTo(x + 6, y + 5);
  g.closePath();
  g.stroke();
  g.fill();
}

/** Points (lat, lon degrees) along the great circle a → b. */
function greatCirclePoints(lat1, lon1, lat2, lon2, n) {
  const v = (la, lo) => [Math.cos(la * DEG) * Math.cos(lo * DEG), Math.cos(la * DEG) * Math.sin(lo * DEG), Math.sin(la * DEG)];
  const a = v(lat1, lon1);
  const b = v(lat2, lon2);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const om = Math.acos(dot);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    let p;
    if (om < 1e-6) p = a;
    else {
      const k0 = Math.sin((1 - s) * om) / Math.sin(om);
      const k1 = Math.sin(s * om) / Math.sin(om);
      p = [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1];
    }
    out.push([Math.asin(Math.max(-1, Math.min(1, p[2]))) / DEG, Math.atan2(p[1], p[0]) / DEG]);
  }
  return out;
}
