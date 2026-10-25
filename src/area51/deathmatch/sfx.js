import { Vector3 } from 'three';
import { mulberry32 } from '../../core/math.js';

/**
 * Deathmatch sounds — synthesised like the rest of the game's audio, added
 * to the Soundscape's one-shot bank once its AudioContext exists, and played
 * positionally: gain falls with distance from the camera, pan follows the
 * bearing, far-off repeats are thinned out, and only a handful of new voices
 * start per frame (a hundred craft firing would otherwise be noise).
 */
const TAU = Math.PI * 2;

function biquad(d, sr, type, f, q = 0.707) {
  const w = (TAU * f) / sr;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  let b0;
  let b1;
  let b2;
  if (type === 'lowpass') {
    b0 = (1 - cs) / 2;
    b1 = 1 - cs;
    b2 = b0;
  } else if (type === 'highpass') {
    b0 = (1 + cs) / 2;
    b1 = -(1 + cs);
    b2 = b0;
  } else {
    b0 = al;
    b1 = 0;
    b2 = -al;
  }
  const a0 = 1 + al;
  const a1 = -2 * cs;
  const a2 = 1 - al;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    d[i] = y;
  }
  return d;
}

function normalize(d, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
  return d;
}

const VOICES = {
  dm_laser(sr) {
    const n = Math.floor(sr * 0.24);
    const d = new Float32Array(n);
    const r = mulberry32(301);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = 380 + 1500 * Math.exp(-t * 22);
      ph += (TAU * f) / sr;
      const env = Math.min(1, t * 900) * Math.exp(-t * 15);
      d[i] = (Math.sin(ph) * 0.7 + Math.sign(Math.sin(ph * 0.5)) * 0.18 + (r() * 2 - 1) * 0.25 * Math.exp(-t * 60)) * env;
    }
    biquad(d, sr, 'lowpass', 5200);
    return normalize(d, 0.8);
  },
  dm_plasma(sr) {
    const n = Math.floor(sr * 0.55);
    const d = new Float32Array(n);
    const s = new Float32Array(n);
    const r = mulberry32(302);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ph += (TAU * (55 + 110 * Math.exp(-t * 14))) / sr;
      d[i] = Math.sin(ph) * Math.exp(-t * 8) * Math.min(1, t * 500);
      s[i] = (r() * 2 - 1) * Math.exp(-t * 6) * (0.6 + 0.4 * Math.sin(TAU * 62 * t));
    }
    biquad(s, sr, 'bandpass', 3200, 0.8);
    for (let i = 0; i < n; i++) d[i] += s[i] * 0.9;
    return normalize(d, 0.9);
  },
  dm_missile(sr) {
    const n = Math.floor(sr * 1.0);
    const d = new Float32Array(n);
    const r = mulberry32(303);
    // noise through a bandpass that sweeps up, a short thump at ignition
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const fc = 400 + 2600 * Math.min(1, t / 0.7);
      const w = (TAU * fc) / sr;
      const al = Math.sin(w) / (2 * 1.3);
      const x = r() * 2 - 1;
      const y = (al * x - al * x2 + 2 * Math.cos(w) * y1 - (1 - al) * y2) / (1 + al);
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      const env = Math.min(1, t / 0.03) * Math.exp(-t * 2.6);
      d[i] = y * env * 3 + Math.sin(TAU * 70 * t) * Math.exp(-t * 18) * 0.6;
    }
    return normalize(d, 0.8);
  },
  dm_arc(sr) {
    const n = Math.floor(sr * 0.5);
    const d = new Float32Array(n);
    const r = mulberry32(304);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if (r() < 0.004) ph += r() * TAU; // buzz jumps phase like an unstable arc
      ph += (TAU * 120) / sr;
      const buzz = ((ph / Math.PI) % 2) - 1;
      const crack = r() < 0.02 ? (r() * 2 - 1) * 2.2 : 0;
      d[i] = (buzz * 0.5 + crack + (r() * 2 - 1) * 0.35) * Math.exp(-t * 5.5) * Math.min(1, t * 800);
    }
    biquad(d, sr, 'highpass', 700);
    return normalize(d, 0.8);
  },
  dm_flame(sr) {
    const n = Math.floor(sr * 0.55);
    const d = new Float32Array(n);
    const r = mulberry32(305);
    let b = 0;
    let flut = 1;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      b = b * 0.985 + (r() * 2 - 1) * 0.15;
      if (i % 400 === 0) flut = 0.6 + r() * 0.6;
      const env = Math.sin(Math.min(1, t / 0.55) * Math.PI) ** 0.7;
      d[i] = (b * 2 + (r() * 2 - 1) * 0.25) * env * flut;
    }
    biquad(d, sr, 'lowpass', 1100);
    return normalize(d, 0.7);
  },
  dm_cannon(sr) {
    const n = Math.floor(sr * 0.16);
    const d = new Float32Array(n);
    const s = new Float32Array(n);
    const r = mulberry32(306);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      s[i] = (r() * 2 - 1) * Math.exp(-t * 45);
      d[i] = Math.sin(TAU * (75 + 60 * Math.exp(-t * 40)) * t) * Math.exp(-t * 26);
    }
    biquad(s, sr, 'bandpass', 1300, 0.9);
    for (let i = 0; i < n; i++) d[i] = d[i] * 0.8 + s[i] * 1.6;
    return normalize(d, 0.85);
  },
  dm_hit(sr) {
    const n = Math.floor(sr * 0.32);
    const d = new Float32Array(n);
    const r = mulberry32(307);
    const parts = [870, 1460, 2210, 3170];
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let v = (r() * 2 - 1) * Math.exp(-t * 120) * 0.8;
      parts.forEach((f, k) => (v += Math.sin(TAU * f * t + k) * Math.exp(-t * (14 + k * 6)) * 0.3));
      d[i] = v;
    }
    return normalize(d, 0.7);
  },
  dm_boom_s(sr) {
    const n = Math.floor(sr * 1.5);
    const d = new Float32Array(n);
    const r = mulberry32(308);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const k = 0.02 + 0.25 * Math.exp(-t * 6); // the roar darkens as it rolls off
      lp += ((r() * 2 - 1) - lp) * k;
      d[i] = lp * 3 * Math.min(1, t * 400) * Math.exp(-t * 2.8) + Math.sin(TAU * (48 + 30 * Math.exp(-t * 8)) * t) * Math.exp(-t * 4) * 0.8;
    }
    return normalize(d, 0.95);
  },
  dm_tele(sr) {
    const n = Math.floor(sr * 1.4);
    const d = new Float32Array(n);
    const r = mulberry32(309);
    const shim = [1210, 1580, 2030, 2610, 3320];
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ph += (TAU * (40 + 80 * Math.exp(-t * 5))) / sr;
      let v = Math.sin(ph) * Math.exp(-t * 3.5) * 0.9;
      const trem = 0.6 + 0.4 * Math.sin(TAU * 28 * t);
      shim.forEach((f, k) => (v += Math.sin(TAU * f * (1 + 0.04 * Math.exp(-t * 3)) * t + k) * Math.exp(-t * (2.5 + k)) * 0.12 * trem));
      v += (r() * 2 - 1) * Math.exp(-t * 14) * 0.4;
      d[i] = v * Math.min(1, t * 300);
    }
    return normalize(d, 0.75);
  },
  dm_lock(sr) {
    const n = Math.floor(sr * 0.07);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] = Math.sin(TAU * 1760 * t) * Math.min(1, t * 400) * Math.min(1, (0.07 - t) * 300);
    }
    return normalize(d, 0.35);
  },
  dm_locked(sr) {
    const n = Math.floor(sr * 0.26);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const on = t < 0.1 || (t > 0.14 && t < 0.24) ? 1 : 0;
      d[i] = Math.sin(TAU * 2640 * t) * on * 0.6;
    }
    return d;
  },
  dm_alarm(sr) {
    const n = Math.floor(sr * 0.5);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = t < 0.25 ? 880 : 660;
      const e = Math.min(1, ((t % 0.25) / 0.01)) * Math.min(1, (0.25 - (t % 0.25)) / 0.02);
      d[i] = (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * f * 2 * t)) * e * 0.5;
    }
    return d;
  },
  dm_go(sr) {
    const n = Math.floor(sr * 1.3);
    const d = new Float32Array(n);
    const fs = [110, 164.8, 220, 277.2];
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let v = 0;
      fs.forEach((f) => (v += ((((f * t) % 1) * 2 - 1) + 0.5 * Math.sin(TAU * f * t)) * 0.25));
      d[i] = v * Math.min(1, t / 0.04) * Math.exp(-t * 1.6);
    }
    biquad(d, sr, 'lowpass', 1800);
    return normalize(d, 0.8);
  },
};

const _d = new Vector3();

export class DmSfx {
  constructor(sound) {
    this.sound = sound;
    this.ready = false;
    this.listener = new Vector3();
    this.right = new Vector3(1, 0, 0);
    this.budget = 0;
    this.last = new Map();
  }

  _build() {
    const S = this.sound;
    if (this.ready || !S.ctx || !S.shots) return;
    const sr = S.ctx.sampleRate;
    for (const [name, fn] of Object.entries(VOICES)) {
      const data = fn(sr);
      const b = S.ctx.createBuffer(1, data.length, sr);
      b.copyToChannel(data, 0);
      S.shots.set(name, b);
    }
    this.ready = true;
  }

  /** Once per frame: where the ears are (arena-local), and a fresh voice budget. */
  frame(pos, right) {
    this._build();
    this.listener.copy(pos);
    this.right.copy(right);
    this.budget = 9;
  }

  /** A sound at an arena-local position. */
  at(name, pos, gain = 1, rate = 1) {
    if (!this.ready || this.budget <= 0) return;
    const d = pos.distanceTo(this.listener);
    const g = gain / (1 + Math.pow(d / 140, 1.35));
    if (g < 0.02) return;
    const now = this.sound.ctx.currentTime;
    const gap = d < 120 ? 0.025 : d < 500 ? 0.07 : 0.16;
    if (now - (this.last.get(name) || 0) < gap) return;
    this.last.set(name, now);
    const pan = d > 1 ? Math.max(-1, Math.min(1, _d.subVectors(pos, this.listener).divideScalar(d).dot(this.right))) * 0.75 : 0;
    // far away: a touch slower and more reverberant
    this.sound.play(name, { gain: g, rate: rate * (1 - Math.min(0.12, d / 12000)), pan, verb: 0.04 + Math.min(0.3, d / 2500) });
    this.budget--;
  }

  /** Non-positional (HUD / your own craft). */
  ui(name, gain = 0.5, rate = 1) {
    if (!this.ready) return;
    this.sound.play(name, { gain, rate, verb: 0 });
  }
}
