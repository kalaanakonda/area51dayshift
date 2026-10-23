import { FLAGS } from '../config.js';
import { clamp } from '../core/math.js';

/**
 * Interaction beats — the film's only gameplay.
 *
 *  hold  : progress fills while the player holds (click / space / touch) and
 *          slowly springs back on release, so a lever *feels* heavy.
 *  press : a single press commits; the hand then performs the motion.
 *
 * `onProgress(p)` drives the physical control (lever angle, dial rotation…);
 * the hand is attached to that control's socket, so the hand moves with it.
 * If nobody acts within `auto` seconds the character acts on their own —
 * the director never lets the shot die.
 */
export class Interactions {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = null;
  }

  run(cfg) {
    const { ui, audio } = this.ctx;
    return new Promise((resolve) => {
      const beat = {
        mode: cfg.mode || 'hold',
        duration: cfg.duration || 1.4,
        auto: FLAGS.auto ? 0.6 : cfg.auto ?? 8,
        progress: 0,
        waited: 0,
        engaged: false,
        autoPlaying: false,
        done: false,
        cfg,
        resolve,
      };
      this.active = beat;
      if (cfg.onStart) cfg.onStart();
      ui.showPrompt(cfg.verb || (beat.mode === 'press' ? 'Press' : 'Hold'), cfg.label || '');
      audio.sfx('dial', { gain: 0.15 });
      this._offPress = this.ctx.input.on('press', () => {
        if (beat.mode === 'press' && !beat.engaged) beat.engaged = true;
      });
    });
  }

  update(dt) {
    const b = this.active;
    if (!b || b.done) return;
    const { input, ui } = this.ctx;
    b.waited += dt;

    if (b.mode === 'hold') {
      if (input.holding) {
        b.engaged = true;
        b.progress += dt / b.duration;
      } else if (!b.autoPlaying) {
        b.progress = Math.max(0, b.progress - dt * 0.45);
      }
    } else if (b.engaged) {
      b.progress += dt / b.duration;
    }

    if (!b.engaged && b.waited > b.auto) b.autoPlaying = true;
    if (b.autoPlaying) b.progress += dt / b.duration;

    b.progress = clamp(b.progress, 0, 1);
    ui.setPromptProgress(b.progress);
    if (b.cfg.onProgress) b.cfg.onProgress(b.progress);

    if (b.progress >= 1) {
      b.done = true;
      ui.completePrompt();
      if (this._offPress) this._offPress();
      if (b.cfg.onComplete) b.cfg.onComplete();
      this.active = null;
      b.resolve();
    }
  }

  /** Abort (chapter jump). */
  cancel() {
    if (this._offPress) this._offPress();
    this.active = null;
    this.ctx.ui.hidePrompt();
  }
}
