import { breathBuffer, buildOneShots, chatterBuffer, crackleBuffer, impulseResponse, noiseBuffer, noteHz } from './synth.js';

/**
 * AudioDirector — the film's sound department (stubbed, but fully playable).
 *
 * Three kinds of sound:
 *   beds     continuous layers whose level the timeline rides
 *            (wind, rumble, hum, static, chatter, space, breath, plasma, marsWind)
 *   sfx      one-shots by cue name (clunk, hiss, foot_metal, quindar_in, …)
 *   score    organ chords + a two-note motif (Interstellar-style restraint)
 *
 * Every cue checks /public/assets/audio/<cue>.(ogg|mp3|m4a|wav) first. If a real
 * recording exists it plays instead of the synthesised placeholder. VO lines are
 * file-only (subtitles always carry the words), keyed by line id: vo_s1_01 …
 */
export class AudioDirector {
  constructor(assets) {
    this.assets = assets;
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.beds = new Map();
    this.fileBuffers = new Map();
    this._geiger = { rate: 0, next: 0 };
    this._ticks = { interval: 0, next: 0, gain: 0.5 };
  }

  /** Create the context + graph. Safe to call before a user gesture (starts suspended). */
  init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx({ latencyHint: 'playback' }));

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master.connect(this.muffle).connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulseResponse(ctx, 4.5, 2.4);
    this.reverbOut = ctx.createGain();
    this.reverbOut.gain.value = 0.32;
    this.reverb.connect(this.reverbOut).connect(this.master);

    const bus = (gain, send) => {
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(this.master);
      if (send) {
        const s = ctx.createGain();
        s.gain.value = send;
        g.connect(s).connect(this.reverb);
      }
      return g;
    };
    this.amb = bus(0.9, 0.1);
    this.sfxBus = bus(1.0, 0.18);
    this.music = bus(0.55, 0.85);
    this.voBus = bus(1.0, 0.08);

    this.shots = buildOneShots(ctx);
    this.noise = {
      white: noiseBuffer(ctx, 4, 'white', 1),
      pink: noiseBuffer(ctx, 4, 'pink', 2),
      brown: noiseBuffer(ctx, 6, 'brown', 3),
      crackle: crackleBuffer(ctx, 3),
      breath: breathBuffer(ctx),
      chatter: chatterBuffer(ctx),
    };
    this._buildBeds();
    this.ready = true;

    // Scheduler for geiger clicks and the ticking clock (look-ahead 120 ms).
    this._schedTimer = setInterval(() => this._schedule(), 40);
  }

  async resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // ------------------------------------------------------------------ beds
  _loop(buffer, rate = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(this.ctx.currentTime + Math.random() * 0.05);
    return src;
  }

  _lfo(freq, depth, target, type = 'sine') {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(target);
    o.start();
    return { o, g };
  }

  _filter(type, freq, q = 0.707) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  _buildBeds() {
    const ctx = this.ctx;
    const mk = (name, out = this.amb) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(out);
      const bed = { gain: g, params: {} };
      this.beds.set(name, bed);
      return bed;
    };

    // Wind: brown noise through a wandering band-pass, gusting, plus a thin whistle.
    {
      const bed = mk('wind');
      const src = this._loop(this.noise.brown);
      const bp = this._filter('bandpass', 520, 0.55);
      this._lfo(0.06, 260, bp.frequency);
      const gust = ctx.createGain();
      gust.gain.value = 0.75;
      this._lfo(0.11, 0.3, gust.gain);
      src.connect(bp).connect(gust).connect(bed.gain);
      const w = this._loop(this.noise.white);
      const wb = this._filter('bandpass', 1500, 9);
      this._lfo(0.05, 300, wb.frequency);
      const wg = ctx.createGain();
      wg.gain.value = 0.05;
      this._lfo(0.13, 0.04, wg.gain);
      w.connect(wb).connect(wg).connect(bed.gain);
      bed.params.intensity = gust.gain;
    }

    // Rumble: engine roar — saturated sub noise + 32 Hz body + crackle tearing.
    {
      const bed = mk('rumble', this.sfxBus);
      const src = this._loop(this.noise.brown, 0.8);
      const lp = this._filter('lowpass', 140, 0.9);
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) curve[i] = Math.tanh((i / 512 - 1) * 2.4);
      shaper.curve = curve;
      const body = ctx.createGain();
      body.gain.value = 1.1;
      src.connect(lp).connect(shaper).connect(body).connect(bed.gain);
      const sub = ctx.createOscillator();
      sub.frequency.value = 32;
      const subG = ctx.createGain();
      subG.gain.value = 0.45;
      this._lfo(7.3, 0.15, subG.gain);
      sub.connect(subG).connect(bed.gain);
      sub.start();
      const cr = this._loop(this.noise.crackle);
      const crh = this._filter('highpass', 350);
      const crg = ctx.createGain();
      crg.gain.value = 0;
      cr.connect(crh).connect(crg).connect(bed.gain);
      bed.params.crackle = crg.gain;
      bed.params.tone = lp.frequency;
    }

    // Ship / building hum: mains harmonics + air handling.
    {
      const bed = mk('hum');
      [55, 110, 165, 220].forEach((f, k) => {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = [0.18, 0.1, 0.05, 0.025][k];
        o.connect(g).connect(bed.gain);
        o.start();
      });
      const air = this._loop(this.noise.pink);
      const lp = this._filter('lowpass', 520);
      const ag = ctx.createGain();
      ag.gain.value = 0.5;
      air.connect(lp).connect(ag).connect(bed.gain);
    }

    // Radio static bed.
    {
      const bed = mk('static', this.voBus);
      const src = this._loop(this.noise.white);
      const bp = this._filter('bandpass', 1900, 0.8);
      const g = ctx.createGain();
      g.gain.value = 0.25;
      src.connect(bp).connect(g).connect(bed.gain);
    }

    // Distant radio chatter (pad PA / handhelds).
    {
      const bed = mk('chatter');
      const src = this._loop(this.noise.chatter);
      const g = ctx.createGain();
      g.gain.value = 0.6;
      const pan = ctx.createStereoPanner();
      pan.pan.value = -0.35;
      src.connect(g).connect(pan).connect(bed.gain);
    }

    // Space: almost nothing — a very low, slow pressure.
    {
      const bed = mk('space');
      const o = ctx.createOscillator();
      o.frequency.value = 41;
      const og = ctx.createGain();
      og.gain.value = 0.25;
      this._lfo(0.05, 0.12, og.gain);
      o.connect(og).connect(bed.gain);
      o.start();
      const n = this._loop(this.noise.pink);
      const bp = this._filter('bandpass', 190, 1.6);
      n.connect(bp).connect(bed.gain);
    }

    // Helmet breathing.
    {
      const bed = mk('breath', this.voBus);
      const src = this._loop(this.noise.breath);
      src.connect(bed.gain);
    }

    // Entry plasma roar: dense, mid-heavy, unsteady.
    {
      const bed = mk('plasma', this.sfxBus);
      const src = this._loop(this.noise.brown, 1.4);
      const bp = this._filter('bandpass', 420, 0.5);
      this._lfo(0.3, 120, bp.frequency);
      const g = ctx.createGain();
      g.gain.value = 1.2;
      this._lfo(5.5, 0.25, g.gain, 'triangle');
      src.connect(bp).connect(g).connect(bed.gain);
      const h = this._loop(this.noise.white);
      const hb = this._filter('bandpass', 2600, 0.8);
      const hg = ctx.createGain();
      hg.gain.value = 0.15;
      h.connect(hb).connect(hg).connect(bed.gain);
    }

    // Mars wind: thin atmosphere — higher, softer, more whisper than roar.
    {
      const bed = mk('marsWind');
      const src = this._loop(this.noise.pink);
      const hp = this._filter('highpass', 380);
      const bp = this._filter('bandpass', 950, 0.45);
      this._lfo(0.045, 380, bp.frequency);
      const g = ctx.createGain();
      g.gain.value = 0.6;
      this._lfo(0.09, 0.3, g.gain);
      src.connect(hp).connect(bp).connect(g).connect(bed.gain);
    }
  }

  /** Ride a bed's level. `fade` is the time to (mostly) reach the target. */
  bed(name, gain, fade = 1.5) {
    if (!this.ready) return;
    const bed = this.beds.get(name);
    if (!bed) return;
    const t = this.ctx.currentTime;
    bed.gain.gain.cancelScheduledValues(t);
    bed.gain.gain.setValueAtTime(bed.gain.gain.value, t);
    if (fade <= 0.01) bed.gain.gain.setValueAtTime(gain, t);
    else bed.gain.gain.setTargetAtTime(gain, t, fade / 3);
  }

  bedParam(name, param, value, fade = 1) {
    if (!this.ready) return;
    const p = this.beds.get(name)?.params[param];
    if (!p) return;
    const t = this.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.setTargetAtTime(value, t, Math.max(0.01, fade / 3));
  }

  /** Hard-cut every bed (smash cut to silence). */
  silence(fade = 0.05) {
    for (const name of this.beds.keys()) this.bed(name, 0, fade);
    this.geiger(0);
    this.ticking(0);
  }

  /** Low-pass the whole mix (inside helmet / through the hull). 0 = open, 1 = heavy. */
  setMuffle(amount, fade = 0.8) {
    if (!this.ready) return;
    const f = 20000 * Math.pow(0.02, Math.min(1, Math.max(0, amount)));
    this.muffle.frequency.setTargetAtTime(f, this.ctx.currentTime, fade / 3);
  }

  // ------------------------------------------------------------------ one-shots
  sfx(name, { gain = 1, pan = 0, delay = 0, rate = 1, reverb = 0 } = {}) {
    if (!this.ready) return;
    const url = this.assets && this.assets.audioUrl(name);
    if (url) {
      this._playFile(url, { gain, pan, delay, bus: this.sfxBus });
      return;
    }
    let buf = this.shots.get(name);
    if (!buf) buf = this.shots.get(`${name}_${Math.floor(Math.random() * 4)}`);
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.sfxBus);
    if (reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = reverb;
      p.connect(s).connect(this.reverb);
    }
    src.start(ctx.currentTime + delay);
    return src;
  }

  /** Repeating one-shot (phone ring). Returns a stop() handle. */
  repeat(name, interval, opts = {}) {
    if (!this.ready) return { stop() {} };
    let alive = true;
    const fire = () => {
      if (!alive) return;
      this.sfx(name, opts);
      timer = setTimeout(fire, interval * 1000);
    };
    let timer = setTimeout(fire, 0);
    return {
      stop() {
        alive = false;
        clearTimeout(timer);
      },
    };
  }

  /** Geiger counter clicks per second (Poisson). 0 stops. */
  geiger(rate) {
    this._geiger.rate = rate;
  }

  /** Clock tick every `interval` seconds (0 stops). The Nolan heartbeat. */
  ticking(interval, gain = 0.5) {
    this._ticks.interval = interval;
    this._ticks.gain = gain;
    if (this.ctx) this._ticks.next = this.ctx.currentTime + 0.05;
  }

  _schedule() {
    if (!this.ready || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const horizon = now + 0.12;
    const g = this._geiger;
    if (g.rate > 0) {
      if (g.next < now) g.next = now;
      while (g.next < horizon) {
        this.sfx('geiger', { gain: 0.35 + Math.random() * 0.3, delay: g.next - now, pan: (Math.random() - 0.5) * 0.4 });
        g.next += -Math.log(1 - Math.random()) / g.rate;
      }
    }
    const tk = this._ticks;
    if (tk.interval > 0) {
      while (tk.next < horizon) {
        this.sfx('tick', { gain: tk.gain, delay: Math.max(0, tk.next - now), reverb: 0.25 });
        tk.next += tk.interval;
      }
    }
  }

  // ------------------------------------------------------------------ score
  /**
   * Organ chord. Each note = 6 harmonic partials × 2 slightly detuned voices,
   * long attack and release, mostly into the reverb. Returns { stop(release) }.
   */
  chord(notes, { gain = 0.18, attack = 3, release = 5, hold = null, brightness = 2200 } = {}) {
    if (!this.ready) return { stop() {} };
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0;
    const lp = this._filter('lowpass', brightness, 0.4);
    out.connect(lp).connect(this.music);
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(gain, t0 + attack);
    const oscs = [];
    const partials = [1, 2, 3, 4, 6, 8];
    const amps = [1, 0.42, 0.2, 0.14, 0.06, 0.035];
    for (const n of notes) {
      const f = typeof n === 'number' ? n : noteHz(n);
      for (let k = 0; k < partials.length; k++) {
        for (const det of [-2.5, 2.5]) {
          const o = ctx.createOscillator();
          o.frequency.value = f * partials[k];
          o.detune.value = det + (Math.random() - 0.5);
          const g = ctx.createGain();
          g.gain.value = (amps[k] / notes.length) * 0.5;
          o.connect(g).connect(out);
          o.start(t0);
          oscs.push(o);
        }
      }
    }
    const stop = (rel = release) => {
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(0, t + rel);
      for (const o of oscs) o.stop(t + rel + 0.1);
    };
    if (hold != null) setTimeout(() => stop(release), (attack + hold) * 1000);
    return { stop };
  }

  /** Soft struck notes (felt piano / glass). The motif of the last scene. */
  pluck(note, { gain = 0.12, delay = 0, decay = 4 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const f = typeof note === 'number' ? note : noteHz(note);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    out.connect(this.music);
    [1, 2.01, 3.02, 4.1].forEach((m, k) => {
      const o = ctx.createOscillator();
      o.frequency.value = f * m;
      const g = ctx.createGain();
      g.gain.value = [1, 0.3, 0.12, 0.05][k];
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + decay + 0.1);
    });
  }

  // ------------------------------------------------------------------ VO + files
  /** Voice line from file if present; returns true if something plays. */
  vo(id, { channel = 'radio', gain = 1 } = {}) {
    const url = this.assets && this.assets.audioUrl(id);
    if (!url || !this.ready) return false;
    const chain = this._voChain(channel);
    this._playFile(url, { gain, bus: chain });
    return true;
  }

  _voChain(channel) {
    const ctx = this.ctx;
    if (channel === 'direct') return this.voBus;
    const hp = this._filter('highpass', channel === 'phone' ? 320 : 420);
    const lp = this._filter('lowpass', channel === 'phone' ? 3400 : 2900);
    hp.connect(lp).connect(this.voBus);
    return hp;
  }

  async _playFile(url, { gain = 1, pan = 0, delay = 0, bus }) {
    try {
      let buf = this.fileBuffers.get(url);
      if (!buf) {
        const res = await fetch(url);
        buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        this.fileBuffers.set(url, buf);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(g).connect(p).connect(bus || this.sfxBus);
      src.start(this.ctx.currentTime + delay);
    } catch (err) {
      console.warn('[audio] could not play', url, err);
    }
  }
}
