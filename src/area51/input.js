/**
 * Controls — keyboard state, pointer-lock mouse look, and one-shot key edges.
 *
 * Mouse look uses pointer lock when the browser grants it; otherwise (embedded
 * previews, some trackpads) dragging with the left button looks around.
 */
export class Controls {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressedNow = new Set();
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.locked = false;
    this.dragging = false;
    this.rightDown = false;
    this.leftDown = false; // the trigger in a deathmatch
    this.enabled = true;
    this.lockWanted = true;
    this.listeners = new Set();

    const block = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'ControlLeft', 'KeyW', 'KeyS', 'KeyA', 'KeyD']);
    window.addEventListener('keydown', (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (block.has(e.code)) e.preventDefault();
      if (!e.repeat) {
        this.pressedNow.add(e.code);
        for (const fn of this.listeners) fn(e.code, e);
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.dragging = false;
      this.rightDown = false;
      this.leftDown = false;
    });

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) this.rightDown = true;
      if (e.button !== 0) return;
      this.leftDown = true;
      if (!this.locked && this.lockWanted && this.enabled) this.lock();
      this.dragging = true;
      this._last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 2) this.rightDown = false;
      if (e.button === 0) this.dragging = this.leftDown = false;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.enabled) return;
      if (this.locked) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      } else if (this.dragging && this._last) {
        this.dx += (e.clientX - this._last.x) * 1.6;
        this.dy += (e.clientY - this._last.y) * 1.6;
        this._last = { x: e.clientX, y: e.clientY };
      }
    });
    window.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: true }
    );
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
    });
  }

  lock() {
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch)
        p.catch(() => {
          const q = this.canvas.requestPointerLock?.();
          if (q && q.catch) q.catch(() => {}); // not allowed here (embedded / no gesture): drag-look still works
        });
    } catch {
      /* drag-look fallback */
    }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  onKey(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  down(...codes) {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  axis(neg, pos) {
    return (this.down(...[].concat(pos)) ? 1 : 0) - (this.down(...[].concat(neg)) ? 1 : 0);
  }

  /** Mouse delta since the last call (pixels). */
  takeMouse() {
    const d = { dx: this.dx, dy: this.dy, wheel: this.wheel };
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    return d;
  }

  /** Call at the end of every frame. */
  endFrame() {
    this.pressedNow.clear();
  }

  pressed(code) {
    return this.pressedNow.has(code);
  }
}
