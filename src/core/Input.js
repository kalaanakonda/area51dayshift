/**
 * Input: absolute mouse position for directed look, plus a single "hold" channel
 * (left mouse / Space / Enter / touch) used by every interaction beat.
 *
 * Design note: the film never asks for more than ONE verb — hold. Mouse look is
 * absolute (cursor position maps to a bounded head offset) rather than pointer-
 * locked, so the player can glance and the director can always pull them back.
 */
export class Input {
  constructor() {
    this.ndc = { x: 0, y: 0 };
    this.hasMoved = false;
    this.holding = false;
    this._sources = new Set();
    this._handlers = new Map();
    this.enabled = true;

    const isUi = (e) => e.target && e.target.closest && e.target.closest('[data-interactive]');

    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.ndc.y = -((e.clientY / window.innerHeight) * 2 - 1);
      this.hasMoved = true;
    });

    window.addEventListener('pointerdown', (e) => {
      if (isUi(e) || !this.enabled) return;
      if (e.pointerType === 'touch') {
        this._touchStart = { x: e.clientX, y: e.clientY, nx: this.ndc.x, ny: this.ndc.y };
      }
      if (e.button === 0) this._press('pointer');
    });

    // Touch fallback: dragging moves the look target like a trackpad.
    window.addEventListener(
      'touchmove',
      (e) => {
        if (!this._touchStart || !e.touches[0]) return;
        const t = e.touches[0];
        this.ndc.x = Math.max(-1, Math.min(1, this._touchStart.nx - ((t.clientX - this._touchStart.x) / window.innerWidth) * 2));
        this.ndc.y = Math.max(-1, Math.min(1, this._touchStart.ny + ((t.clientY - this._touchStart.y) / window.innerHeight) * 2));
        this.hasMoved = true;
      },
      { passive: true }
    );

    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this._release('pointer');
    });
    window.addEventListener('pointercancel', () => this._release('pointer'));

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (!e.repeat && this.enabled) this._press('key');
      }
      if (!e.repeat) this._emit('key', e);
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' || e.code === 'Enter') this._release('key');
    });

    window.addEventListener('blur', () => {
      this._sources.clear();
      this._setHolding(false);
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type).delete(fn);
  }

  _emit(type, payload) {
    const set = this._handlers.get(type);
    if (set) for (const fn of set) fn(payload);
  }

  _press(source) {
    this._sources.add(source);
    this._setHolding(true);
    this._emit('press', source);
  }

  _release(source) {
    if (!this._sources.delete(source)) return;
    if (this._sources.size === 0) this._setHolding(false);
  }

  _setHolding(v) {
    if (this.holding === v) return;
    this.holding = v;
    this._emit(v ? 'holdstart' : 'holdend');
  }
}
