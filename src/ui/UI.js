import { CHAPTERS } from '../config.js';

/**
 * DOM layer: loading screen, subtitles, the single interaction prompt, pause
 * menu, end card, device notice, debug HUD. No framework — a film needs very
 * little chrome, and every element here fades rather than pops.
 */
export class UI {
  constructor(root) {
    this.root = root;
    this.handlers = {};
    this._buildLoader();
    this._buildSubs();
    this._buildPrompt();
    this._buildPause();
    this._buildEnd();
    this.toastEl = el('div', 'toast');
    root.appendChild(this.toastEl);
    this.subsEnabled = true;
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }

  _emit(name, ...args) {
    if (this.handlers[name]) this.handlers[name](...args);
  }

  // ------------------------------------------------------------------ loader
  _buildLoader() {
    const L = el('section', 'loader grain');
    const title = 'First Step';
    const letters = [...title]
      .map((c, i) => `<span style="animation-delay:${0.6 + i * 0.12}s">${c === ' ' ? '&nbsp;' : c}</span>`)
      .join('');
    L.innerHTML = `
      <div class="loader__horizon"></div>
      <div class="loader__frame">
        <div class="loader__eyebrow">Crew Flight 01 &nbsp;·&nbsp; Starbase, Texas <b>→</b> Arcadia Planitia, Mars</div>
        <h1 class="loader__title" aria-label="${title}">${letters}</h1>
        <div class="loader__line"><i></i></div>
        <div class="loader__status">Preparing</div>
        <button class="loader__begin" data-interactive type="button">Begin</button>
        <div class="loader__notes">
          Headphones recommended. A first-person short film, about six minutes.<br />
          Move the mouse to look when the frame allows it. Hold <kbd>click</kbd> or <kbd>space</kbd> when asked.<br />
          <kbd>Esc</kbd> pause &nbsp; <kbd>M</kbd> mute &nbsp; <kbd>C</kbd> subtitles &nbsp; <kbd>Q</kbd> quality
        </div>
      </div>
      <div class="loader__foot">
        <div>An independent fan work · not affiliated with or endorsed by SpaceX · all dialogue is fictional</div>
        <div class="loader__coords">25.997° N 97.157° W</div>
      </div>`;
    this.root.appendChild(L);
    this.loader = L;
    this.loaderBar = L.querySelector('.loader__line i');
    this.loaderStatus = L.querySelector('.loader__status');
    this.loaderCoords = L.querySelector('.loader__coords');
    L.querySelector('.loader__begin').addEventListener('click', () => this._emit('begin'));
  }

  setProgress(fraction, label) {
    this.loaderBar.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
    if (label) this.loaderStatus.textContent = `${label} — ${Math.round(fraction * 100)}%`;
  }

  loaderReady(summary) {
    this.loaderStatus.textContent = summary;
    this.loader.classList.add('is-ready');
    this.loaderCoords.textContent = '46.7° N 197.8° E · Arcadia Planitia';
    const btn = this.loader.querySelector('.loader__begin');
    setTimeout(() => btn.focus({ preventScroll: true }), 400);
  }

  hideLoader() {
    this.loader.classList.add('is-gone');
    document.body.classList.add('is-playing');
  }

  // ------------------------------------------------------------------ subtitles
  _buildSubs() {
    this.subs = el('div', 'subs');
    this.subs.innerHTML = `<div class="subs__line"><div class="subs__speaker"></div><div class="subs__text"></div></div>`;
    this.root.appendChild(this.subs);
    this.subLine = this.subs.querySelector('.subs__line');
    this.subSpeaker = this.subs.querySelector('.subs__speaker');
    this.subText = this.subs.querySelector('.subs__text');
  }

  /** channel: 'phone' | 'radio' | 'computer' | 'direct' */
  say(speaker, text, channel = 'radio') {
    this.subSpeaker.textContent = speaker;
    this.subSpeaker.dataset.channel = channel;
    this.subText.textContent = text;
    this.subLine.classList.add('is-on');
  }

  clearSay() {
    this.subLine.classList.remove('is-on');
  }

  toggleSubs() {
    this.subsEnabled = !this.subsEnabled;
    this.subs.classList.toggle('is-hidden', !this.subsEnabled);
    this.toast(this.subsEnabled ? 'Subtitles on' : 'Subtitles off');
  }

  /** Keep subtitles inside the lower letterbox bar. */
  setBar(px) {
    this.root.style.setProperty('--bar', `${px}px`);
  }

  // ------------------------------------------------------------------ prompt
  _buildPrompt() {
    const P = el('div', 'prompt');
    P.innerHTML = `
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle class="ring-bg" cx="20" cy="20" r="17"></circle>
        <circle class="ring-fg" cx="20" cy="20" r="17" stroke-dasharray="106.8" stroke-dashoffset="106.8"></circle>
        <circle class="ring-dot" cx="20" cy="20" r="2.2"></circle>
      </svg>
      <div class="prompt__text"><em></em><span></span></div>`;
    this.root.appendChild(P);
    this.prompt = P;
    this.promptRing = P.querySelector('.ring-fg');
    this.promptVerb = P.querySelector('.prompt__text em');
    this.promptLabel = P.querySelector('.prompt__text span');
  }

  showPrompt(verb, label) {
    this.promptVerb.textContent = verb;
    this.promptLabel.textContent = label;
    this.prompt.classList.remove('is-complete');
    this.setPromptProgress(0);
    this.prompt.classList.add('is-on');
  }

  setPromptProgress(p) {
    this.promptRing.setAttribute('stroke-dashoffset', String(106.8 * (1 - Math.max(0, Math.min(1, p)))));
  }

  completePrompt() {
    this.prompt.classList.add('is-complete');
    setTimeout(() => this.prompt.classList.remove('is-on'), 450);
  }

  hidePrompt() {
    this.prompt.classList.remove('is-on');
  }

  // ------------------------------------------------------------------ pause
  _buildPause() {
    const P = el('div', 'pause');
    P.innerHTML = `
      <div class="pause__inner">
        <div class="pause__title">Paused</div>
        <ol class="pause__chapters">
          ${CHAPTERS.map(
            (c) =>
              `<li><button data-interactive data-chapter="${c.id}" type="button"><span>${c.numeral}</span>${c.title}<span>Play</span></button></li>`
          ).join('')}
        </ol>
        <div class="pause__row">
          <button data-interactive data-primary data-act="resume" type="button">Resume</button>
          <button data-interactive data-act="subs" type="button">Subtitles</button>
          <button data-interactive data-act="mute" type="button">Sound</button>
          <button data-interactive data-act="quality" type="button">Quality</button>
        </div>
        <div class="pause__hint"></div>
      </div>`;
    this.root.appendChild(P);
    this.pause = P;
    this.pauseHint = P.querySelector('.pause__hint');
    P.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.chapter) this._emit('chapter', parseInt(b.dataset.chapter, 10));
      else if (b.dataset.act) this._emit(b.dataset.act);
    });
  }

  showPause(on, hint = '') {
    this.pause.classList.toggle('is-on', on);
    this.pauseHint.textContent = hint;
    document.body.classList.toggle('is-playing', !on);
  }

  // ------------------------------------------------------------------ end card
  _buildEnd() {
    const E = el('div', 'endcard');
    E.innerHTML = `
      <div>
        <div class="endcard__title">First Step</div>
        <div class="endcard__credits">
          A first-person short<br />
          Starbase, Texas &nbsp;→&nbsp; Arcadia Planitia, Mars<br />
          Built with Three.js · Procedural placeholders awaiting BlendKit assets<br />
          An independent fan work — not affiliated with or endorsed by SpaceX
        </div>
        <button class="endcard__replay" data-interactive type="button">Watch again</button>
      </div>`;
    this.root.appendChild(E);
    this.end = E;
    E.querySelector('.endcard__replay').addEventListener('click', () => this._emit('replay'));
  }

  showTitle(on) {
    this.end.classList.toggle('is-on', on);
    if (!on) this.end.classList.remove('is-credits');
  }

  showCredits() {
    this.end.classList.add('is-on', 'is-credits');
    document.body.classList.remove('is-playing');
  }

  // ------------------------------------------------------------------ misc
  toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('is-on');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.toastEl.classList.remove('is-on'), 1800);
  }

  deviceNotice() {
    return new Promise((resolve) => {
      const D = el('div', 'device');
      D.innerHTML = `
        <div class="device__inner">
          <h2>First Step</h2>
          <p>This is a first-person film made for a laptop or desktop: a mouse to look, a key or click to act, and a GPU with some headroom.</p>
          <p>On a phone it will run at reduced quality, and touch stands in for the mouse — drag to look, tap and hold to act.</p>
          <button data-interactive type="button">Continue anyway</button>
        </div>`;
      this.root.appendChild(D);
      D.querySelector('button').addEventListener('click', () => {
        D.remove();
        resolve();
      });
    });
  }

  fatal(message) {
    const D = el('div', 'device');
    D.innerHTML = `<div class="device__inner"><h2>First Step</h2><p>${message}</p></div>`;
    this.root.appendChild(D);
  }

  debugPanel() {
    const D = el('div', 'debug');
    D.setAttribute('data-interactive', '');
    this.root.appendChild(D);
    return D;
  }
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
