import './dmhud.css';
import { GLYPH, ORDER, WEAPONS } from './weapons.js';

/**
 * Deathmatch HUD, laid over the game's own: clock and standings (top),
 * kill feed (top right), hull (bottom left), weapons 1–6 (bottom centre),
 * and a canvas for everything that tracks the world — brackets on craft,
 * the reticle for the weapon in hand, missile lock, hit markers, damage
 * arcs and a radar.
 */
const html = String.raw;
const MINT = '155, 242, 195';
const RED = '255, 93, 77';
const AMBER = '255, 191, 94';

export class DmHud {
  constructor(root, { onAgain, onLeave } = {}) {
    this.root = root;
    const el = document.createElement('div');
    el.className = 'dm';
    el.hidden = true;
    el.innerHTML = html`
      <canvas class="dm-canvas"></canvas>
      <div class="dm-hurt" data-hurt></div>
      <div class="dm-top">
        <span data-timer>00:00</span>
        <span>KILLS <b data-kills>0</b></span>
        <span>RANK <b data-rank>–</b></span>
        <span class="lead" data-lead></span>
      </div>
      <div class="dm-feed" data-feed></div>
      <div class="dm-hull" data-hullbox>
        <div class="row"><b>HULL</b><span data-hull>0</span></div>
        <div class="bar"><div data-hullbar></div></div>
        <div class="sub" data-sub></div>
      </div>
      <div class="dm-weapons" data-weapons></div>
      <div class="dm-banner off" data-banner><div class="k"></div><div class="t"></div><div class="l"></div><div class="c"></div></div>
      <div class="dm-count" data-count></div>
      <div class="dm-msg" data-msg></div>
      <div class="dm-board" data-board hidden></div>
      <div class="dm-results" data-results hidden></div>
    `;
    root.appendChild(el);
    this.el = el;
    const q = (s) => el.querySelector(s);
    this.e = {
      canvas: q('.dm-canvas'),
      hurt: q('[data-hurt]'),
      timer: q('[data-timer]'),
      kills: q('[data-kills]'),
      rank: q('[data-rank]'),
      lead: q('[data-lead]'),
      feed: q('[data-feed]'),
      hullbox: q('[data-hullbox]'),
      hull: q('[data-hull]'),
      hullbar: q('[data-hullbar]'),
      sub: q('[data-sub]'),
      weapons: q('[data-weapons]'),
      banner: q('[data-banner]'),
      count: q('[data-count]'),
      msg: q('[data-msg]'),
      board: q('[data-board]'),
      results: q('[data-results]'),
    };
    this.g = this.e.canvas.getContext('2d');
    this.slots = ORDER.map((id) => {
      const w = WEAPONS[id];
      const d = document.createElement('div');
      d.className = 'w';
      d.innerHTML = html`<span class="k">${w.key}</span>${w.name}<span class="g">${GLYPH[id]}</span><div class="bar"><div></div></div>`;
      this.e.weapons.appendChild(d);
      return { id, el: d, bar: d.querySelector('.bar div') };
    });
    this._text = new Map();
    this._acc = 1;
    this.hits = []; // { t, kill }
    this.hurts = []; // { a (radians, screen), t }
    this.hurtLevel = 0;
    this.onAgain = onAgain;
    this.onLeave = onLeave;
    this.e.results.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.act === 'again' && this.onAgain) this.onAgain();
      if (b.dataset.act === 'leave' && this.onLeave) this.onLeave();
    });
  }

  show(on) {
    this.el.hidden = !on;
    if (on) this.root.dataset.dm = '';
    else delete this.root.dataset.dm;
  }

  /** The intro: titles only, the instruments out of the way. */
  cinematic(on) {
    this.el.classList.toggle('cine', on);
  }

  _set(el, text) {
    if (this._text.get(el) === text) return;
    this._text.set(el, text);
    el.textContent = text;
  }

  _html(el, h) {
    if (this._text.get(el) === h) return;
    this._text.set(el, h);
    el.innerHTML = h;
  }

  banner(b) {
    const B = this.e.banner;
    if (!b) {
      B.classList.add('off');
      return;
    }
    B.classList.remove('off');
    this._set(B.querySelector('.k'), b.kicker || '');
    this._set(B.querySelector('.t'), b.title || '');
    this._set(B.querySelector('.l'), b.lede || '');
    this._set(B.querySelector('.c'), b.count || '');
  }

  countdown(text) {
    const c = this.e.count;
    c.textContent = text;
    c.classList.toggle('go', text === 'FIGHT');
    c.classList.remove('pop');
    void c.offsetWidth; // restart the animation
    c.classList.add('pop');
  }

  message(h) {
    this._html(this.e.msg, h || '');
  }

  kill(e, me) {
    const k = e.killer;
    const v = e.victim;
    const d = document.createElement('div');
    d.className = `kf${k === me ? ' me' : ''}${v === me ? ' mine' : ''}`;
    const nm = (s) => (s === me ? '<span class="you">YOU</span>' : esc(s.name));
    d.innerHTML = k ? `${nm(k)}<i>${GLYPH[e.weapon] || '✕'}</i>${nm(v)}` : `${nm(v)}<i>${GLYPH.crash}</i>`;
    const F = this.e.feed;
    F.insertBefore(d, F.firstChild);
    while (F.children.length > 6) F.lastChild.remove();
    setTimeout(() => d.classList.add('out'), 6000);
    setTimeout(() => d.remove(), 7000);
  }

  hitMarker(kill) {
    this.hits.push({ t: 0, kill });
  }

  hurt(angle, amount) {
    this.hurts.push({ a: angle, t: 0 });
    if (this.hurts.length > 8) this.hurts.shift();
    this.hurtLevel = Math.min(1, this.hurtLevel + amount / 30);
  }

  board(rows, on) {
    const B = this.e.board;
    B.hidden = !on;
    if (on) this._html(B, `<h3>Standings · Nuremberg</h3>${table(rows)}`);
  }

  results(r) {
    const R = this.e.results;
    if (!r) {
      R.hidden = true;
      return;
    }
    R.hidden = false;
    R.innerHTML = html`
      <h3>Deathmatch over · ${esc(r.reason)}</h3>
      <h2>${r.rank === 1 ? 'You win' : `You placed #${r.rank}`}</h2>
      <div class="sub">${r.kills} kills · ${r.deaths} deaths · winner ${esc(r.winner)}</div>
      ${table(r.rows)}
      <div class="actions"><button type="button" data-act="again">Fight again</button><button type="button" class="alt" data-act="leave">Back to Day Shift</button></div>
    `;
  }

  /**
   * d = { timer, kills, rank, total, leader, hp, maxHp, sub, weapon, me,
   *       status: { laser: 0..1, … } , hot: { laser: bool, … } }
   */
  update(dt, d) {
    this.hurtLevel = Math.max(0, this.hurtLevel - dt * 1.4);
    this.e.hurt.style.opacity = this.hurtLevel.toFixed(3);
    this._acc += dt;
    if (this._acc < 0.06) return;
    this._acc = 0;
    const E = this.e;
    const m = Math.max(0, Math.floor(d.timer / 60));
    const s = Math.max(0, Math.floor(d.timer % 60));
    this._set(E.timer, `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    E.timer.classList.toggle('low', d.timer < 30);
    this._set(E.kills, String(d.kills));
    this._set(E.rank, `${d.rank}/${d.total}`);
    this._set(E.lead, d.leader ? `LEAD ${d.leader}` : '');
    const hp = Math.max(0, d.hp);
    this._set(E.hull, String(Math.ceil(hp)));
    E.hullbar.style.transform = `scaleX(${(hp / d.maxHp).toFixed(3)})`;
    E.hullbox.classList.toggle('low', hp / d.maxHp < 0.3 && hp > 0);
    this._set(E.sub, d.sub || '');
    for (const sl of this.slots) {
      sl.el.classList.toggle('on', sl.id === d.weapon);
      sl.el.classList.toggle('hot', !!d.hot[sl.id]);
      sl.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, d.status[sl.id] ?? 1)).toFixed(3)})`;
    }
  }

  /**
   * Canvas layer. v = { project(localPos, out) → out{x, y, z, on}, ships, me,
   *   target, lock: { ship, p (0..1), locked }, weapon, fovPx (px per radian at
   *   the centre), heading (rad, arena frame), showBrackets, crosshair }
   */
  draw(dt, v) {
    const c = this.e.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(c.clientWidth * dpr);
    const H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = this.g;
    g.clearRect(0, 0, W, H);
    if (!v) return;
    g.save();
    g.scale(dpr, dpr);
    const w = W / dpr;
    const h = H / dpr;
    const cx = w / 2;
    const cy = h / 2;
    const me = v.me;
    const P = {};
    if (v.showBrackets) {
      // full brackets on the nearest few, pips on the rest; your target and
      // whoever is shooting you always get one
      const list = [];
      for (const s of v.ships) {
        if (s === me || s.state !== 'alive') continue;
        const d = s.pos.distanceTo(me.pos);
        const isT = s === v.target;
        const angry = s.lastHitT > 0 && me.lastHitBy === s && v.time - me.lastHitT < 3;
        if (d > 2200 && !isT && !angry) continue;
        list.push([isT || angry ? -1 : d, d, s, isT, angry]);
      }
      list.sort((a, b) => a[0] - b[0]);
      let full = 0;
      let pips = 0;
      for (const [rank, dist, s, isT, angry] of list) {
        if (full >= 10 && pips >= 24) break;
        if (!v.project(s.pos, P) || !P.on) continue;
        const x = P.x * w;
        const y = P.y * h;
        const a = Math.max(0.35, 1 - dist / 2400);
        if (rank >= 0 && (dist > 950 || full >= 10)) {
          if (pips >= 24) continue;
          pips++;
          // a small diamond
          g.fillStyle = `rgba(232, 239, 233, ${a * 0.7})`;
          g.beginPath();
          g.moveTo(x, y - 2.5);
          g.lineTo(x + 2.5, y);
          g.lineTo(x, y + 2.5);
          g.lineTo(x - 2.5, y);
          g.closePath();
          g.fill();
          continue;
        }
        full++;
        const r = Math.max(9, Math.min(80, (s.radius * v.fovPx) / Math.max(1, P.z))) + 4;
        const col = isT ? RED : angry ? AMBER : '232, 239, 233';
        g.strokeStyle = `rgba(${col}, ${a})`;
        g.lineWidth = isT ? 1.6 : 1.1;
        const k = Math.min(7, r * 0.45);
        g.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          g.moveTo(x + sx * r, y + sy * (r - k));
          g.lineTo(x + sx * r, y + sy * r);
          g.lineTo(x + sx * (r - k), y + sy * r);
        }
        g.stroke();
        if (isT || dist < 900) {
          const bw = Math.max(18, r * 1.4);
          g.fillStyle = `rgba(0,0,0,${0.45 * a})`;
          g.fillRect(x - bw / 2, y + r + 4, bw, 3);
          const f = Math.max(0, s.hp / s.maxHp);
          g.fillStyle = f < 0.3 ? `rgba(${RED}, ${a})` : `rgba(${MINT}, ${a})`;
          g.fillRect(x - bw / 2, y + r + 4, bw * f, 3);
        }
        if (isT || angry || dist < 420) {
          g.font = `600 ${isT ? 11 : 10}px "Chakra Petch", sans-serif`;
          g.textAlign = 'center';
          g.fillStyle = `rgba(${col}, ${Math.min(1, a + 0.2)})`;
          g.fillText(`${s.name}${isT ? ` · ${Math.round(dist)} m` : ''}`, x, y - r - 6);
        }
      }
    }
    // missile lock
    const L = v.lock;
    if (L && L.ship && v.project(L.ship.pos, P) && P.on) {
      const x = P.x * w;
      const y = P.y * h;
      const r = 26 - L.p * 10;
      g.save();
      g.translate(x, y);
      g.rotate(L.locked ? Math.PI / 4 : (1 - L.p) * Math.PI);
      g.strokeStyle = `rgba(${AMBER}, ${0.5 + 0.5 * L.p})`;
      g.lineWidth = L.locked ? 2.2 : 1.3;
      g.strokeRect(-r, -r, r * 2, r * 2);
      g.restore();
      if (L.locked) {
        g.font = '600 11px "Chakra Petch", sans-serif';
        g.textAlign = 'center';
        g.fillStyle = `rgba(${AMBER}, 1)`;
        g.fillText('LOCK', x, y + 34);
      }
    }
    if (v.crosshair) this._reticle(g, cx, cy, v);
    // hit markers
    for (const hm of this.hits) {
      hm.t += dt;
      const a = 1 - hm.t / 0.3;
      if (a <= 0) continue;
      g.strokeStyle = hm.kill ? `rgba(${RED}, ${a})` : `rgba(255,255,255,${a})`;
      g.lineWidth = hm.kill ? 2.4 : 1.6;
      const s1 = 7;
      const s2 = 15 + (hm.kill ? 5 : 0);
      g.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        g.moveTo(cx + sx * s1, cy + sy * s1);
        g.lineTo(cx + sx * s2, cy + sy * s2);
      }
      g.stroke();
    }
    this.hits = this.hits.filter((x) => x.t < 0.3);
    // damage arcs, pointing at whoever shot
    for (const d of this.hurts) {
      d.t += dt;
      const a = 1 - d.t / 1.3;
      if (a <= 0) continue;
      g.strokeStyle = `rgba(${RED}, ${a * 0.9})`;
      g.lineWidth = 5;
      g.beginPath();
      g.arc(cx, cy, Math.min(w, h) * 0.2, d.a - 0.28 - Math.PI / 2, d.a + 0.28 - Math.PI / 2);
      g.stroke();
    }
    this.hurts = this.hurts.filter((x) => x.t < 1.3);
    if (v.radar) this._radar(g, w, h, v);
    g.restore();
  }

  _reticle(g, cx, cy, v) {
    const on = !!v.target;
    const col = on ? RED : MINT;
    g.strokeStyle = `rgba(${col}, 0.9)`;
    g.fillStyle = `rgba(${col}, 0.95)`;
    g.lineWidth = 1.4;
    const px = (rad) => Math.tan(rad) * v.fovPx;
    switch (v.weapon) {
      case 'plasma': {
        const r = Math.max(14, px(WEAPONS.plasma.spread * 1.1));
        for (let k = 0; k < 4; k++) {
          g.beginPath();
          g.arc(cx, cy, r, k * (Math.PI / 2) + 0.25, (k + 1) * (Math.PI / 2) - 0.25);
          g.stroke();
        }
        g.fillRect(cx - 1.5, cy - 1.5, 3, 3);
        break;
      }
      case 'missile': {
        const r = Math.max(30, px(WEAPONS.missile.lockCone));
        g.setLineDash([3, 5]);
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
        g.beginPath();
        g.moveTo(cx, cy - 6);
        g.lineTo(cx + 6, cy);
        g.lineTo(cx, cy + 6);
        g.lineTo(cx - 6, cy);
        g.closePath();
        g.stroke();
        break;
      }
      case 'fire': {
        const r = Math.max(24, px(WEAPONS.fire.cone));
        g.beginPath();
        g.arc(cx, cy, r, Math.PI * 0.8, Math.PI * 1.2);
        g.stroke();
        g.beginPath();
        g.arc(cx, cy, r, -Math.PI * 0.2, Math.PI * 0.2);
        g.stroke();
        g.fillRect(cx - 1.5, cy - 1.5, 3, 3);
        break;
      }
      case 'arc': {
        const r = Math.max(16, px(WEAPONS.arc.cone));
        for (const sx of [-1, 1]) {
          g.beginPath();
          g.moveTo(cx + sx * (r + 6), cy - 10);
          g.lineTo(cx + sx * r, cy - 2);
          g.lineTo(cx + sx * (r + 5), cy + 2);
          g.lineTo(cx + sx * (r - 1), cy + 10);
          g.stroke();
        }
        g.fillRect(cx - 1.5, cy - 1.5, 3, 3);
        break;
      }
      case 'cannon': {
        g.beginPath();
        g.moveTo(cx - 9, cy);
        g.lineTo(cx - 3, cy);
        g.moveTo(cx + 3, cy);
        g.lineTo(cx + 9, cy);
        g.moveTo(cx, cy - 9);
        g.lineTo(cx, cy - 3);
        g.stroke();
        // drop ticks: where rounds fall at 300 / 600 m
        g.globalAlpha = 0.7;
        for (const [k, r] of [[1, 300], [2, 600]]) {
          const t = r / WEAPONS.cannon.speed;
          const drop = 0.5 * 9.81 * t * t;
          const y = cy + px(Math.atan(drop / r));
          g.beginPath();
          g.moveTo(cx - 5 + k, y);
          g.lineTo(cx + 5 - k, y);
          g.stroke();
        }
        g.globalAlpha = 1;
        break;
      }
      default: {
        // laser: dot and four ticks
        g.fillRect(cx - 1.5, cy - 1.5, 3, 3);
        g.beginPath();
        for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          g.moveTo(cx + sx * 8, cy + sy * 8);
          g.lineTo(cx + sx * 14, cy + sy * 14);
        }
        g.stroke();
        if (v.heat > 0.02) {
          g.strokeStyle = `rgba(${v.heat > 0.8 ? RED : AMBER}, 0.85)`;
          g.lineWidth = 2;
          g.beginPath();
          g.arc(cx, cy, 20, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * v.heat);
          g.stroke();
        }
      }
    }
  }

  _radar(g, w, h, v) {
    const R = 70;
    const x0 = 30 + R;
    const y0 = h - 108 - R;
    g.fillStyle = 'rgba(6, 10, 9, 0.5)';
    g.strokeStyle = `rgba(${MINT}, 0.35)`;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(x0, y0, R, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(x0, y0, R / 2, 0, Math.PI * 2);
    g.stroke();
    const range = 2000;
    const me = v.me;
    const hd = v.heading; // 0 = local −Z (north), clockwise
    const ch = Math.cos(hd);
    const sh = Math.sin(hd);
    for (const s of v.ships) {
      if (s === me || (s.state !== 'alive' && s.state !== 'down')) continue;
      const dx = s.pos.x - me.pos.x;
      const dz = s.pos.z - me.pos.z;
      // rotate so your heading points up the scope
      const rx = dx * ch + dz * sh;
      const ry = dz * ch - dx * sh;
      const d = Math.hypot(rx, ry);
      if (d > range) continue;
      const px = x0 + (rx / range) * R;
      const py = y0 + (ry / range) * R;
      const above = s.pos.y > me.pos.y + 60;
      const below = s.pos.y < me.pos.y - 60;
      const sz = s.radius > 10 ? 3 : 2;
      g.fillStyle = s.state === 'down' ? 'rgba(160,160,160,0.5)' : s === v.target ? `rgba(${RED},1)` : me.lastHitBy === s && v.time - me.lastHitT < 3 ? `rgba(${AMBER},1)` : 'rgba(232,239,233,0.8)';
      if (above) {
        g.beginPath();
        g.moveTo(px, py - sz - 1);
        g.lineTo(px + sz + 1, py + sz);
        g.lineTo(px - sz - 1, py + sz);
        g.fill();
      } else if (below) {
        g.beginPath();
        g.moveTo(px, py + sz + 1);
        g.lineTo(px + sz + 1, py - sz);
        g.lineTo(px - sz - 1, py - sz);
        g.fill();
      } else g.fillRect(px - sz, py - sz, sz * 2, sz * 2);
    }
    // you
    g.fillStyle = `rgba(${MINT}, 1)`;
    g.beginPath();
    g.moveTo(x0, y0 - 6);
    g.lineTo(x0 + 4, y0 + 4);
    g.lineTo(x0 - 4, y0 + 4);
    g.closePath();
    g.fill();
    g.font = '500 9px "IBM Plex Mono", monospace';
    g.textAlign = 'center';
    g.fillStyle = 'rgba(214,228,220,0.5)';
    g.fillText('2 KM', x0, y0 + R + 12);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** rows: [{ rank, name, style, kills, deaths, me, gap }] */
function table(rows) {
  const tr = rows
    .map((r) => (r.gap ? '<tr class="gap"><td colspan="5">⋯</td></tr>' : `<tr${r.me ? ' class="me"' : ''}><td class="n">${r.rank}</td><td>${esc(r.name)}</td><td>${esc(r.style)}</td><td class="n">${r.kills}</td><td class="n">${r.deaths}</td></tr>`))
    .join('');
  return `<table><tr><th class="n">#</th><th>Pilot</th><th>Craft</th><th class="n">K</th><th class="n">D</th></tr>${tr}</table>`;
}
