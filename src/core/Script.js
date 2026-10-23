import gsap from 'gsap';

/**
 * Script — a tiny screenplay DSL over a GSAP timeline.
 *
 * Every call takes an absolute time `t` (seconds from the start of the scene),
 * so a scene file reads like a shot list:
 *
 *   s.fade(0, 1, 3);
 *   s.cam(2, { yaw: -0.8, pitch: 0.35 }, 6, 'sine.inOut');
 *   s.say(4, 'ELON', 'Look up.', 2.5, 'phone', 'vo_s1_05');
 *   s.beat(9, { verb: 'Hold', label: 'Pull the latch lever', onProgress: p => lever.set(p) });
 *
 * Beats pause the timeline (GSAP addPause) until the player acts — or until the
 * auto-timer acts for them, so the film never stalls.
 */
export class Script {
  constructor(ctx, tl) {
    this.ctx = ctx;
    this.tl = tl;
    this.beats = [];
  }

  /** Tween any object's props. */
  to(t, target, props, dur = 1, ease = 'sine.inOut') {
    this.tl.to(target, { ...props, duration: dur, ease }, t);
    return this;
  }

  fromTo(t, target, from, to, dur = 1, ease = 'sine.inOut') {
    this.tl.fromTo(target, from, { ...to, duration: dur, ease, immediateRender: false }, t);
    return this;
  }

  set(t, target, props) {
    this.tl.set(target, props, t);
    return this;
  }

  call(t, fn) {
    this.tl.call(fn, null, t);
    return this;
  }

  /** Directed camera: x, y, z, yaw, pitch, roll, fov. */
  cam(t, props, dur = 2, ease = 'sine.inOut') {
    if (dur <= 0) return this.set(t, this.ctx.rig.dir, props);
    return this.to(t, this.ctx.rig.dir, props, dur, ease);
  }

  /** Teleport (cut) the camera — also resets the gait tracker so no fake step fires. */
  cut(t, props) {
    this.tl.set(this.ctx.rig.dir, props, t);
    this.tl.call(() => this.ctx.rig.cut(), null, t);
    return this;
  }

  /** Mouse glance window: weight 0..1 and limits in radians. */
  look(t, weight, { yaw, pitch } = {}, dur = 1.5) {
    const props = { weight };
    if (yaw != null) props.yawLimit = yaw;
    if (pitch != null) props.pitchLimit = pitch;
    return this.to(t, this.ctx.rig.look, props, dur, 'sine.inOut');
  }

  feel(t, props, dur = 1) {
    return this.to(t, this.ctx.rig.feel, props, dur, 'sine.inOut');
  }

  shake(t, trauma) {
    return this.call(t, () => this.ctx.rig.addTrauma(trauma));
  }

  rumble(t, amount, dur = 1, freq) {
    const props = { rumble: amount };
    if (freq) props.rumbleFreq = freq;
    return this.to(t, this.ctx.rig.shake, props, dur, 'sine.inOut');
  }

  sway(t, amount, dur = 1) {
    return this.to(t, this.ctx.rig.shake, { sway: amount }, dur, 'sine.inOut');
  }

  // ---------------------------------------------------------------- picture
  fade(t, to, dur = 1, ease = 'sine.inOut') {
    const u = this.ctx.post.grade.uFade;
    if (dur <= 0) this.tl.set(u, { value: to }, t);
    else this.tl.to(u, { value: to, duration: dur, ease }, t);
    return this;
  }

  flash(t, amount, dur = 0.6, color) {
    const u = this.ctx.post.grade;
    if (color) this.call(t, () => u.uFlashColor.value.set(color));
    this.tl.set(u.uFlash, { value: amount }, t);
    this.tl.to(u.uFlash, { value: 0, duration: dur, ease: 'power2.out' }, t + 0.016);
    return this;
  }

  letterbox(t, to, dur = 3, ease = 'sine.inOut') {
    const u = this.ctx.post.grade.uLetterbox;
    if (dur <= 0) this.tl.set(u, { value: to }, t);
    else this.tl.to(u, { value: to, duration: dur, ease }, t);
    return this;
  }

  grade(t, name, dur = 2) {
    return this.call(t, () => this.ctx.post.toGrade(name, dur));
  }

  exposure(t, value, dur = 2, ease = 'sine.inOut') {
    const L = this.ctx.post.look;
    this.tl.to(L, { exposure: value, duration: dur, ease, onUpdate: () => this.ctx.post.applyLook() }, t);
    return this;
  }

  shafts(t, intensity, dur = 2) {
    return this.to(t, this.ctx.post.sun, { intensity }, dur, 'sine.inOut');
  }

  // ---------------------------------------------------------------- sound
  bed(t, name, gain, fade = 1.5) {
    return this.call(t, () => this.ctx.audio.bed(name, gain, fade));
  }

  bedParam(t, name, param, value, fade = 1) {
    return this.call(t, () => this.ctx.audio.bedParam(name, param, value, fade));
  }

  sfx(t, name, opts) {
    return this.call(t, () => this.ctx.audio.sfx(name, opts));
  }

  chord(t, notes, opts) {
    return this.call(t, () => {
      const h = this.ctx.audio.chord(notes, opts);
      if (opts && opts.key) this.ctx.music[opts.key] = h;
    });
  }

  stopChord(t, key, release = 4) {
    return this.call(t, () => {
      const h = this.ctx.music[key];
      if (h) h.stop(release);
      delete this.ctx.music[key];
    });
  }

  /**
   * Subtitle + optional VO file. `id` maps to /public/assets/audio/<id>.ogg|mp3.
   * Radio lines are bracketed with Quindar tones like Apollo-era air-to-ground.
   */
  say(t, speaker, text, dur, channel = 'radio', id = null) {
    const { ui, audio } = this.ctx;
    this.call(t, () => {
      ui.say(speaker, text, channel);
      if (id) audio.vo(id, { channel });
      if (channel === 'radio') audio.sfx('quindar_in', { gain: 0.25 });
    });
    this.call(t + dur, () => {
      ui.clearSay();
      if (channel === 'radio') audio.sfx('quindar_out', { gain: 0.22 });
    });
    return this;
  }

  // ---------------------------------------------------------------- interaction
  /**
   * Interaction beat. Pauses the timeline at `t` until the action completes.
   * cfg: { verb, label, mode: 'hold'|'press', duration, auto, onStart, onProgress, onComplete }
   */
  beat(t, cfg) {
    this.beats.push({ t, ...cfg });
    this.tl.addPause(t, () => {
      this.ctx.interactions.run(cfg).then(() => {
        // Resume on the next tick so completion callbacks settle first.
        gsap.delayedCall(0.05, () => this.tl.resume());
      });
    });
    return this;
  }
}
