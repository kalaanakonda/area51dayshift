import { Minimap } from './Minimap.js';

/**
 * DOM HUD over the canvas. Projected-avionics look: hairlines, phosphor
 * mint, amber for anything you should act on. Text updates ~20×/s; the map
 * and the heading tape are canvases.
 */
const html = String.raw;

export class Hud {
  constructor(root) {
    this.root = root;
    root.innerHTML = html`
      <section class="mission" aria-live="polite">
        <div class="k"><span>DAY SHIFT</span><span data-clock></span></div>
        <div class="title"><span class="step" data-step></span><span data-title></span></div>
        <div class="detail" data-detail></div>
        <div class="wp"><i class="diamond"></i><span data-wpname></span><span class="num" data-wpdist></span></div>
      </section>
      <canvas class="tape" width="10" height="10"></canvas>
      <section class="air">
        <div class="mode"><b>MODE</b><span data-drivemode>PARKED</span></div>
        <div class="row"><b>GS</b><span data-gs>0</span><i>km/h</i></div>
        <div class="row"><b>MACH</b><span data-mach>0.00</span><i></i></div>
        <div class="row"><b>ALT</b><span data-alt>0</span><i>m</i></div>
        <div class="row"><b>AGL</b><span data-agl>0</span><i>m</i></div>
        <div class="row"><b>V/S</b><span data-vs>0</span><i>m/s</i></div>
        <div class="drive"><b>DRIVE</b><div class="bar"><div data-bar></div></div><span data-pwr>0%</span></div>
      </section>
      <section class="map">
        <div class="disc" data-disc></div>
        <div class="meta"><span data-coords></span><span data-where></span></div>
      </section>
      <section class="warpbox" data-warpbox>
        <div class="wk"><b data-wstate>WARP</b><span data-wfactor></span></div>
        <div class="wname" data-wname></div>
        <div class="wbar"><div data-wbar></div></div>
        <div class="wrem" data-wrem></div>
      </section>
      <div class="reticle"></div>
      <div class="prompt" data-prompt><kbd></kbd><span></span></div>
      <div class="toasts" data-toasts></div>
      <div class="attrib" data-attrib></div>
      <div class="overlay" data-overlay hidden>
        <div class="classif" data-classif>TOP SECRET // S-4 // ARV PROGRAM // TRAINING USE ONLY</div>
        <div class="ov">
          <div class="kicker" data-kicker>Groom Lake, Nevada · Hangar 9 · <span data-ovclock></span></div>
          <h1 data-ovtitle>Day Shift</h1>
          <p class="lede" data-ovlede>Clock in, walk the hangar floor, take ARV-3 out through the door — then fly it anywhere on Earth.</p>
          <div class="cards" data-cards>
            <div class="card">
              <h3>On foot</h3>
              <dl>
                <dt>W A S D</dt><dd>Walk · Shift to hurry</dd>
                <dt>Mouse</dt><dd>Look around</dd>
                <dt>E</dt><dd>Board ARV-3 at the tail ramp</dd>
                <dt>M</dt><dd>Nav map · search the planet</dd>
                <dt>[ &nbsp;]</dt><dd>Wind the clock back / on</dd>
              </dl>
            </div>
            <div class="card">
              <h3>In the seat</h3>
              <dl>
                <dt>R</dt><dd>Spool / shut down the drive</dd>
                <dt>Space · C</dt><dd>Climb · descend and land</dd>
                <dt>W S</dt><dd>Thrust where the nose points</dd>
                <dt>A D</dt><dd>Slide left · right</dd>
                <dt>Mouse</dt><dd>Fly the craft · turn and pitch the nose</dd>
                <dt>Right drag</dt><dd>Look around (orbit in chase view)</dd>
                <dt>V</dt><dd>Cockpit · third person · chase camera</dd>
                <dt>Shift</dt><dd>Boost ×3</dd>
                <dt>Q</dt><dd>Overdrive · hypersonic, no inertia</dd>
                <dt>1–0 · − =</dt><dd>Speed gear · Overdrive up to Mach 150</dd>
                <dt>M</dt><dd>Nav map · search or click anywhere</dd>
                <dt>J</dt><dd>Warp to the pin (again to cancel)</dd>
                <dt>N</dt><dd>Next waypoint</dd>
                <dt>F</dt><dd>Climb out (Hangar 9 only)</dd>
              </dl>
            </div>
          </div>
          <div class="earth"><i class="dot" data-earthdot></i><span data-earth></span></div>
          <div class="actions">
            <button type="button" class="go" data-go>Clock in</button>
            <button type="button" class="mute" data-mute aria-pressed="false">Sound on</button>
            <button type="button" class="mute alt" data-ovalt hidden></button>
          </div>
          <div class="loading" data-loading></div>
        </div>
        <div class="classif" data-classif>TOP SECRET // S-4 // ARV PROGRAM // TRAINING USE ONLY</div>
      </div>
    `;
    const q = (s) => root.querySelector(s);
    this.el = {
      clock: q('[data-clock]'),
      step: q('[data-step]'),
      title: q('[data-title]'),
      detail: q('[data-detail]'),
      wpname: q('[data-wpname]'),
      wpdist: q('[data-wpdist]'),
      gs: q('[data-gs]'),
      alt: q('[data-alt]'),
      agl: q('[data-agl]'),
      vs: q('[data-vs]'),
      bar: q('[data-bar]'),
      pwr: q('[data-pwr]'),
      coords: q('[data-coords]'),
      where: q('[data-where]'),
      prompt: q('[data-prompt]'),
      toasts: q('[data-toasts]'),
      attrib: q('[data-attrib]'),
      overlay: q('[data-overlay]'),
      ovtitle: q('[data-ovtitle]'),
      ovlede: q('[data-ovlede]'),
      ovclock: q('[data-ovclock]'),
      earth: q('[data-earth]'),
      earthdot: q('[data-earthdot]'),
      go: q('[data-go]'),
      mute: q('[data-mute]'),
      ovalt: q('[data-ovalt]'),
      kicker: q('[data-kicker]'),
      cards: q('[data-cards]'),
      classif: [...root.querySelectorAll('[data-classif]')],
      drivemode: q('[data-drivemode]'),
      mach: q('[data-mach]'),
      warpbox: q('[data-warpbox]'),
      wstate: q('[data-wstate]'),
      wfactor: q('[data-wfactor]'),
      wname: q('[data-wname]'),
      wbar: q('[data-wbar]'),
      wrem: q('[data-wrem]'),
      loading: q('[data-loading]'),
    };
    this.tape = q('.tape');
    this.tg = this.tape.getContext('2d');
    this.minimap = new Minimap(q('[data-disc]'));
    this._acc = 1;
    this._prompt = '';
    this._mode = '';
    this._text = new Map();
    this.el.go.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._onGo) this._onGo();
    });
    this.el.mute.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onMute) this.onMute();
    });
    this.el.ovalt.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._onAlt) this._onAlt();
    });
  }

  /**
   * Swap the start card's framing (the deathmatch has its own): kicker and
   * cards are HTML, the rest text. Anything left out stays as it is.
   */
  setIntro({ classif, kicker, lede, cards }) {
    if (classif) for (const c of this.el.classif) c.textContent = classif;
    if (kicker) {
      this.el.kicker.innerHTML = kicker;
      this.el.ovclock = this.el.kicker.querySelector('[data-ovclock]') || document.createElement('span');
    }
    if (lede) this.el.ovlede.textContent = lede;
    if (cards) this.el.cards.innerHTML = cards;
  }

  setMuted(m) {
    this.el.mute.textContent = m ? 'Sound off' : 'Sound on';
    this.el.mute.setAttribute('aria-pressed', String(!!m));
  }

  setEarth(text, good) {
    this.el.earth.textContent = text;
    this.el.earthdot.classList.toggle('good', !!good);
  }

  setAttribution(text) {
    this._set(this.el.attrib, text);
  }

  /** Start / pause card. alt = { label, onClick } adds a second button. */
  showOverlay({ title, lede, button, onGo, alt = null }) {
    this.el.ovtitle.textContent = title;
    if (lede) this.el.ovlede.textContent = lede;
    this.el.go.textContent = button;
    this._onGo = onGo;
    this.el.ovalt.hidden = !alt;
    this._onAlt = alt ? alt.onClick : null;
    if (alt) this.el.ovalt.textContent = alt.label;
    this.el.overlay.hidden = false;
    this.root.classList.add('has-overlay');
  }

  /** The start button: a progress readout while the game warms up (p 0..1), then live. */
  setGo(text, enabled, p = 1) {
    this._set(this.el.go, text);
    this.el.go.disabled = !enabled;
    this.el.go.style.setProperty('--p', `${Math.round(p * 100)}%`);
  }

  hideOverlay() {
    this.el.overlay.hidden = true;
    this.root.classList.remove('has-overlay');
  }

  get overlayOpen() {
    return !this.el.overlay.hidden;
  }

  setLoading(text) {
    this._set(this.el.loading, text);
  }

  toast(text, kind = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    this.el.toasts.appendChild(t);
    while (this.el.toasts.children.length > 3) this.el.toasts.firstChild.remove();
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 4000);
  }

  _set(el, text) {
    if (this._text.get(el) === text) return;
    this._text.set(el, text);
    el.textContent = text;
  }

  /**
   * d = { mode, clock, lat, lon, heading, alt, agl, speed, vs, power, mach,
   *       drive: 'PARKED'|'CRUISE'|'OVERDRIVE'|'WARP', warp: {state, name, factor, remaining, progress}|null,
   *       objective: {title, detail, step, total, wp}, prompt: {key, text}|null, home }
   */
  update(dt, d) {
    if (d.mode !== this._mode) {
      this._mode = d.mode;
      this.root.dataset.mode = d.mode;
    }
    this.minimap.update(dt, { lat: d.lat, lon: d.lon, heading: d.heading, agl: d.agl, speed: d.speed, home: d.home, wp: d.objective?.wp });
    this._acc += dt;
    if (this._acc < 0.05) return;
    this._acc = 0;
    const E = this.el;
    this._set(E.clock, d.clock);
    this._set(E.ovclock, d.clock);
    const o = d.objective;
    if (o) {
      this._set(E.step, o.step >= o.total ? '✓' : `${o.step + 1}/${o.total}`);
      this._set(E.title, o.title);
      this._set(E.detail, o.detail);
      if (o.wp) {
        this._set(E.wpname, o.wp.name);
        this._set(E.wpdist, `${fmtDist(o.wp.dist)} · ${String(Math.round(o.wp.brg)).padStart(3, '0')}°`);
      }
    }
    this._set(E.gs, group(Math.round(d.speed * 3.6)));
    this._set(E.mach, (d.mach ?? 0) < 10 ? (d.mach ?? 0).toFixed(2) : (d.mach ?? 0).toFixed(1));
    if (d.drive && E.drivemode.dataset.state !== d.drive) {
      E.drivemode.dataset.state = d.drive;
      E.drivemode.textContent = d.drive;
    }
    const w = d.warp;
    E.warpbox.classList.toggle('on', !!w);
    this.root.classList.toggle('warping', !!w);
    if (w) {
      this._set(E.wstate, w.state === 'spool' ? 'CHARGING' : w.state === 'exit' ? 'DROPPING OUT' : 'WARP');
      this._set(E.wfactor, w.state === 'jump' && w.factor ? `W ${w.factor.toFixed(1)}` : '');
      this._set(E.wname, `→ ${w.name}`);
      E.wbar.style.transform = `scaleX(${Math.max(0, Math.min(1, w.progress)).toFixed(3)})`;
      this._set(E.wrem, w.state === 'spool' ? 'Hands on the pads · J to abort' : w.state === 'exit' ? 'Arriving' : `${fmtDist(w.remaining)} to go`);
    }
    this._set(E.alt, group(Math.round(d.alt)));
    this._set(E.agl, group(Math.round(Math.max(0, d.agl))));
    this._set(E.vs, `${d.vs >= 0 ? '+' : '−'}${Math.abs(d.vs).toFixed(1)}`);
    E.bar.style.transform = `scaleX(${d.power.toFixed(3)})`;
    this._set(E.pwr, `${Math.round(d.power * 100)}%`);
    this._set(E.coords, `${Math.abs(d.lat).toFixed(4)}°${d.lat >= 0 ? 'N' : 'S'}  ${Math.abs(d.lon).toFixed(4)}°${d.lon >= 0 ? 'E' : 'W'}`);
    this._set(E.where, d.where || '');
    const p = d.prompt ? `${d.prompt.key}|${d.prompt.text}` : '';
    if (p !== this._prompt) {
      this._prompt = p;
      E.prompt.classList.toggle('on', !!d.prompt);
      if (d.prompt) {
        E.prompt.querySelector('kbd').textContent = d.prompt.key;
        E.prompt.querySelector('span').textContent = d.prompt.text;
      }
    }
    if (d.mode !== 'walk') this._drawTape(d);
  }

  _drawTape(d) {
    const c = this.tape;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(c.clientWidth * dpr);
    const H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = this.tg;
    g.clearRect(0, 0, W, H);
    const span = 70; // degrees across the tape
    const pxPerDeg = W / span;
    const hdg = ((d.heading % 360) + 360) % 360;
    const x = (deg) => {
      let dd = deg - hdg;
      dd = ((dd + 540) % 360) - 180;
      return W / 2 + dd * pxPerDeg;
    };
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let a = Math.floor((hdg - span / 2) / 5) * 5; a <= hdg + span / 2 + 5; a += 5) {
      const deg = ((a % 360) + 360) % 360;
      const xx = x(deg);
      const major = deg % 15 === 0;
      const fade = 1 - Math.min(1, Math.abs(xx - W / 2) / (W / 2)) ** 3;
      g.globalAlpha = fade;
      g.strokeStyle = 'rgba(232,239,233,0.8)';
      g.lineWidth = major ? 1.5 * dpr : 1 * dpr;
      g.beginPath();
      g.moveTo(xx, H - (major ? 13 : 7) * dpr);
      g.lineTo(xx, H);
      g.stroke();
      if (major) {
        const card = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[deg];
        g.fillStyle = card === 'N' ? '#ffbf5e' : 'rgba(232,239,233,0.9)';
        g.font = card ? `600 ${12 * dpr}px "Chakra Petch", sans-serif` : `500 ${10 * dpr}px "IBM Plex Mono", monospace`;
        g.fillText(card || String(deg).padStart(3, '0'), xx, 2 * dpr);
      }
    }
    g.globalAlpha = 1;
    // bugs: waypoint (mint diamond) and home (amber)
    const bug = (deg, color, shape) => {
      let xx = x(deg);
      xx = Math.max(6 * dpr, Math.min(W - 6 * dpr, xx));
      g.fillStyle = color;
      g.beginPath();
      if (shape === 'diamond') {
        g.moveTo(xx, H - 16 * dpr);
        g.lineTo(xx + 5 * dpr, H - 11 * dpr);
        g.lineTo(xx, H - 6 * dpr);
        g.lineTo(xx - 5 * dpr, H - 11 * dpr);
      } else {
        g.moveTo(xx - 5 * dpr, H - 6 * dpr);
        g.lineTo(xx - 5 * dpr, H - 12 * dpr);
        g.lineTo(xx, H - 16 * dpr);
        g.lineTo(xx + 5 * dpr, H - 12 * dpr);
        g.lineTo(xx + 5 * dpr, H - 6 * dpr);
      }
      g.closePath();
      g.fill();
    };
    if (d.homeBrg != null) bug(d.homeBrg, '#ffbf5e', 'home');
    if (d.objective?.wp) bug(d.objective.wp.brg, '#9bf2c3', 'diamond');
    // lubber box
    const bw = 44 * dpr;
    const bh = 20 * dpr;
    g.fillStyle = 'rgba(6,10,10,0.78)';
    g.strokeStyle = 'rgba(155,242,195,0.9)';
    g.lineWidth = 1 * dpr;
    g.fillRect(W / 2 - bw / 2, H - bh - 18 * dpr, bw, bh);
    g.strokeRect(W / 2 - bw / 2, H - bh - 18 * dpr, bw, bh);
    g.fillStyle = '#e8efe9';
    g.font = `500 ${13 * dpr}px "IBM Plex Mono", monospace`;
    g.textBaseline = 'middle';
    g.fillText(String(Math.round(hdg) % 360).padStart(3, '0'), W / 2, H - bh / 2 - 18 * dpr);
  }
}

function group(n) {
  return n.toLocaleString('en-US');
}

export function fmtDist(m) {
  const a = Math.abs(m);
  if (a < 1000) return `${Math.round(m)} m`;
  if (a < 100000) return `${(m / 1000).toFixed(1)} km`;
  return `${group(Math.round(m / 1000))} km`;
}
