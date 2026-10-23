import { buildOneShots, chatterBuffer, impulseResponse, noiseBuffer } from '../audio/synth.js';

/**
 * Soundscape — all synthesised (src/audio/synth.js), started on the first click.
 *
 *   hangar : room tone + HVAC, distant radio chatter, a big reverb
 *   feet   : concrete footsteps from the walker
 *   drive  : the saucer's gravitic hum (two detuned partials + a field whine)
 *            — loud in the seat, distant from the floor
 *   wind   : canopy wind that rises with airspeed (and thins out with height)
 *   warp   : a charging tone that climbs while the field spools, then a roar
 *            in the tunnel; sonic booms and the jump thumps are one-shots
 */
export class Soundscape {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const out = ctx.createDynamicsCompressor();
    out.threshold.value = -14;
    out.ratio.value = 3;
    out.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(out);

    // hangar reverb bus
    this.verb = ctx.createConvolver();
    this.verb.buffer = impulseResponse(ctx, 3.4, 2.4, 7);
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.35;
    this.verb.connect(this.verbGain).connect(this.master);

    const loop = (buf, gain = 0) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      const g = ctx.createGain();
      g.gain.value = gain;
      s.connect(g);
      s.start();
      return { src: s, gain: g };
    };

    // room tone
    const brown = noiseBuffer(ctx, 6, 'brown', 11);
    const pink = noiseBuffer(ctx, 6, 'pink', 12);
    this.room = loop(brown, 0);
    const roomLp = ctx.createBiquadFilter();
    roomLp.type = 'lowpass';
    roomLp.frequency.value = 220;
    this.room.gain.connect(roomLp).connect(this.master);
    this.hvac = loop(pink, 0);
    const hvacBp = ctx.createBiquadFilter();
    hvacBp.type = 'bandpass';
    hvacBp.frequency.value = 520;
    hvacBp.Q.value = 0.6;
    this.hvac.gain.connect(hvacBp).connect(this.master);
    // distant radio
    this.radio = loop(chatterBuffer(ctx, 33), 0);
    const pan = ctx.createStereoPanner();
    pan.pan.value = -0.45;
    this.radio.gain.connect(pan);
    pan.connect(this.master);
    pan.connect(this.verb);

    // wind
    this.wind = loop(noiseBuffer(ctx, 6, 'pink', 21), 0);
    this.windBp = ctx.createBiquadFilter();
    this.windBp.type = 'bandpass';
    this.windBp.frequency.value = 400;
    this.windBp.Q.value = 0.7;
    this.wind.gain.connect(this.windBp).connect(this.master);

    // drive hum
    this.hum = ctx.createGain();
    this.hum.gain.value = 0;
    this.humLp = ctx.createBiquadFilter();
    this.humLp.type = 'lowpass';
    this.humLp.frequency.value = 300;
    this.humLp.Q.value = 2.5;
    this.hum.connect(this.humLp);
    this.humLp.connect(this.master);
    this.humLp.connect(this.verb);
    this.oscs = [
      [55, 'sine', 0.55],
      [55.4, 'triangle', 0.32],
      [110.3, 'sine', 0.22],
      [164.6, 'sine', 0.08],
    ].map(([f, type, a]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = a;
      o.connect(g).connect(this.hum);
      o.start();
      return { o, base: f };
    });
    // slow wobble on the hum (field "breathing")
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.31;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.9;
    lfo.connect(lfoGain);
    for (const { o } of this.oscs) lfoGain.connect(o.detune);
    lfo.start();
    this.whine = ctx.createOscillator();
    this.whine.frequency.value = 3150;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.master);
    this.whine.start();

    // warp: charge tone (spool) + tunnel roar
    this.charge = ctx.createOscillator();
    this.charge.type = 'sawtooth';
    this.charge.frequency.value = 70;
    this.chargeLp = ctx.createBiquadFilter();
    this.chargeLp.type = 'lowpass';
    this.chargeLp.frequency.value = 400;
    this.chargeLp.Q.value = 7;
    this.chargeGain = ctx.createGain();
    this.chargeGain.gain.value = 0;
    this.charge.connect(this.chargeLp).connect(this.chargeGain).connect(this.master);
    this.charge.start();
    this.roar = loop(noiseBuffer(ctx, 6, 'brown', 31), 0);
    this.roarLp = ctx.createBiquadFilter();
    this.roarLp.type = 'lowpass';
    this.roarLp.frequency.value = 300;
    this.roarLp.Q.value = 1.2;
    this.roar.gain.connect(this.roarLp).connect(this.master);

    this.shots = buildOneShots(ctx);
    if (this.muted) this.master.gain.value = 0;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.1);
  }

  play(name, { gain = 1, rate = 1, pan = 0, verb = 0.3 } = {}) {
    if (!this.ctx || !this.shots) return;
    const buf = this.shots.get(name);
    if (!buf) return;
    const ctx = this.ctx;
    try {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = gain;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      s.connect(g).connect(p);
      p.connect(this.master);
      if (verb) {
        const v = ctx.createGain();
        v.gain.value = verb;
        p.connect(v).connect(this.verb);
      }
      s.start();
    } catch (err) {
      console.warn('[audio]', name, err); // never let a sound break the game
    }
  }

  footstep(amp, side) {
    const v = Math.floor(Math.random() * 4);
    this.play(`foot_concrete_${v}`, { gain: 0.18 + amp * 0.3, rate: 0.94 + Math.random() * 0.12, pan: side ? 0.12 : -0.12, verb: 0.5 });
  }

  /**
   * s = { inside (0..1), seated, power, thrust, speed (m/s), dist (m from the craft),
   *       alt (m), warpCharge (0..1), warpTunnel (0..1), overdrive (bool) }
   */
  update(dt, s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = 0.12;
    const inside = s.inside;
    this.room.gain.gain.setTargetAtTime(0.16 * inside + 0.03, t, k * 3);
    this.hvac.gain.gain.setTargetAtTime(0.035 * inside, t, k * 3);
    this.radio.gain.gain.setTargetAtTime(s.seated ? 0.0 : 0.05 * inside, t, k * 3);
    this.verbGain.gain.setTargetAtTime(0.1 + 0.32 * inside, t, k * 3);

    const near = s.seated ? 1 : Math.max(0, 1 - s.dist / 60) ** 2;
    const p = s.power;
    const od = s.overdrive ? 1 : 0;
    this.hum.gain.setTargetAtTime(p * (0.05 + 0.09 * near) * (1 + s.thrust * 0.6 + od * 0.3), t, k);
    this.humLp.frequency.setTargetAtTime(180 + p * 260 + s.thrust * 900 + od * 500, t, k);
    for (const { o, base } of this.oscs) o.frequency.setTargetAtTime(base * (0.75 + 0.25 * p) * (1 + s.thrust * 0.18 + od * 0.12), t, k);
    this.whineGain.gain.setTargetAtTime(p * 0.0045 * near * (1 + s.thrust), t, k);
    this.whine.frequency.setTargetAtTime(2900 + p * 400 + s.thrust * 900, t, k);

    const v = s.seated ? s.speed : 0;
    const w = Math.min(1, Math.sqrt(v / 250));
    const air = Math.exp(-Math.max(0, s.alt || 0) / 9000); // thin air up high, none in space
    this.wind.gain.gain.setTargetAtTime(w * 0.14 * air * (1 - inside * 0.8), t, k * 2);
    this.windBp.frequency.setTargetAtTime(260 + w * 1400, t, k * 2);

    const wc = s.warpCharge || 0;
    this.chargeGain.gain.setTargetAtTime(wc * 0.07, t, 0.06);
    this.charge.frequency.setTargetAtTime(70 + wc * wc * 820, t, 0.06);
    this.chargeLp.frequency.setTargetAtTime(400 + wc * 3200, t, 0.06);
    const wt = s.warpTunnel || 0;
    this.roar.gain.gain.setTargetAtTime(wt * 0.55, t, 0.12);
    this.roarLp.frequency.setTargetAtTime(260 + wt * 1100, t, 0.12);
  }
}
