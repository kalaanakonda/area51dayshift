/**
 * Procedural sound library. Every one-shot is synthesised once into an
 * AudioBuffer (pure JS DSP), then played by the AudioDirector. Real recordings
 * dropped into /public/assets/audio/<cue>.ogg|mp3 replace these by name.
 */
import { mulberry32 } from '../core/math.js';

const NOTE_INDEX = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** 'A2' → 110 Hz */
export function noteHz(name) {
  const m = /^([A-G]#?)(-?\d)$/.exec(name);
  if (!m) return 440;
  const midi = NOTE_INDEX[m[1]] + (parseInt(m[2], 10) + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function buffer(ctx, seconds, channels = 1) {
  const len = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  return ctx.createBuffer(channels, len, ctx.sampleRate);
}

/** RBJ biquad, processed in place on a Float32Array. */
function biquad(data, sr, type, freq, q = 0.707) {
  const w0 = (2 * Math.PI * freq) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
  } else {
    b0 = alpha; b1 = 0; b2 = -alpha; // bandpass (0 dB peak)
  }
  a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    data[i] = y;
  }
  return data;
}

function normalize(data, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < data.length; i++) m = Math.max(m, Math.abs(data[i]));
  if (m > 0) for (let i = 0; i < data.length; i++) data[i] *= peak / m;
  return data;
}

function fadeEdges(data, sr, fin = 0.004, fout = 0.01) {
  const a = Math.floor(fin * sr);
  const b = Math.floor(fout * sr);
  for (let i = 0; i < a && i < data.length; i++) data[i] *= i / a;
  for (let i = 0; i < b && i < data.length; i++) data[data.length - 1 - i] *= i / b;
  return data;
}

// ---------------------------------------------------------------- noise beds

export function noiseBuffer(ctx, seconds, color = 'white', seed = 1, channels = 2) {
  const buf = buffer(ctx, seconds, channels);
  for (let c = 0; c < channels; c++) {
    const rand = mulberry32(seed * 7919 + c * 104729);
    const d = buf.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = rand() * 2 - 1;
      if (color === 'white') d[i] = w;
      else if (color === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02; // brown
        d[i] = last * 3.5;
      }
    }
    // Crossfade the loop seam.
    const xf = Math.floor(0.05 * ctx.sampleRate);
    for (let i = 0; i < xf; i++) {
      const t = i / xf;
      d[i] = d[i] * t + d[d.length - xf + i] * (1 - t);
    }
  }
  return buf;
}

/** Sparse crackle (rocket "tearing" texture) — impulses through a bandpass. */
export function crackleBuffer(ctx, seconds = 3, seed = 9) {
  const buf = buffer(ctx, seconds, 2);
  for (let c = 0; c < 2; c++) {
    const rand = mulberry32(seed + c * 31);
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      d[i] = rand() < 0.004 ? (rand() * 2 - 1) * (0.5 + rand()) : (rand() * 2 - 1) * 0.04;
    }
    biquad(d, ctx.sampleRate, 'bandpass', 900, 0.6);
    normalize(d, 0.9);
  }
  return buf;
}

/** Algorithmic reverb impulse: decaying stereo noise with a soft early cluster. */
export function impulseResponse(ctx, seconds = 4, decay = 2.6, seed = 3) {
  const buf = buffer(ctx, seconds, 2);
  for (let c = 0; c < 2; c++) {
    const rand = mulberry32(seed + c * 101);
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const t = i / d.length;
      d[i] = (rand() * 2 - 1) * Math.pow(1 - t, decay);
    }
    biquad(d, ctx.sampleRate, 'lowpass', 5200, 0.5);
  }
  return buf;
}

/** Helmet breathing loop (~7.6 s): inhale through teeth, slow exhale. */
export function breathBuffer(ctx, seed = 4) {
  const sr = ctx.sampleRate;
  const buf = buffer(ctx, 7.6, 2);
  for (let c = 0; c < 2; c++) {
    const rand = mulberry32(seed + c);
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
    biquad(d, sr, 'bandpass', 900, 0.5);
    biquad(d, sr, 'lowpass', 2400, 0.6);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const inhale = t > 0.2 && t < 1.9 ? Math.sin(((t - 0.2) / 1.7) * Math.PI) ** 1.5 : 0;
      const exhale = t > 2.6 && t < 5.4 ? Math.sin(((t - 2.6) / 2.8) * Math.PI) ** 2 * 0.75 : 0;
      d[i] *= inhale + exhale;
    }
    normalize(d, 0.5);
  }
  return buf;
}

// ---------------------------------------------------------------- one-shots

const ONE_SHOTS = {
  ring(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 2.2, 1);
    const d = buf.getChannelData(0);
    const hits = [0, 0.16, 0.6, 0.76];
    const freqs = [1318.5, 1975.5, 1318.5, 1975.5];
    hits.forEach((h, k) => {
      const s0 = Math.floor(h * sr);
      for (let i = 0; i < sr * 0.9 && s0 + i < d.length; i++) {
        const t = i / sr;
        const env = Math.exp(-t * 7) * Math.min(1, t * 400);
        d[s0 + i] += (Math.sin(2 * Math.PI * freqs[k] * t) + 0.25 * Math.sin(2 * Math.PI * freqs[k] * 2.01 * t)) * env * 0.4;
      }
    });
    return buf;
  },
  answer(ctx) {
    return tones(ctx, [[660, 0, 0.07], [990, 0.08, 0.1]], 0.35);
  },
  hangup(ctx) {
    return tones(ctx, [[880, 0, 0.09], [660, 0.11, 0.09], [440, 0.22, 0.14]], 0.3);
  },
  squelch(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.16, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(77);
    for (let i = 0; i < d.length; i++) d[i] = (rand() * 2 - 1) * Math.exp(-(i / sr) * 22);
    biquad(d, sr, 'bandpass', 2200, 0.9);
    return fadeEdges(normalize(d, 0.6), sr);
  },
  quindar_in(ctx) {
    return tones(ctx, [[2525, 0, 0.25]], 0.22);
  },
  quindar_out(ctx) {
    return tones(ctx, [[2475, 0, 0.25]], 0.22);
  },
  beep(ctx) {
    return tones(ctx, [[1200, 0, 0.12]], 0.25);
  },
  confirm(ctx) {
    return tones(ctx, [[880, 0, 0.08], [1320, 0.1, 0.16]], 0.25);
  },
  chime(ctx) {
    return tones(ctx, [[784, 0, 0.9], [988, 0.18, 0.9], [1175, 0.36, 1.2]], 0.22, 4);
  },
  tick(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.08, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(5);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = Math.sin(2 * Math.PI * 1750 * t) * Math.exp(-t * 160) * 0.8 + (rand() * 2 - 1) * Math.exp(-t * 900) * 0.5;
    }
    return fadeEdges(d, sr, 0.0005);
  },
  switch(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.07, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(11);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = (rand() * 2 - 1) * Math.exp(-t * 700) + Math.sin(2 * Math.PI * 2900 * t) * Math.exp(-t * 120) * 0.4;
    }
    biquad(d, sr, 'highpass', 900);
    return fadeEdges(normalize(d, 0.7), sr, 0.0003);
  },
  guard(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.12, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(12);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = (rand() * 2 - 1) * Math.exp(-t * 300) * 0.8 + Math.sin(2 * Math.PI * 900 * t) * Math.exp(-t * 60) * 0.3;
    }
    biquad(d, sr, 'bandpass', 1400, 0.8);
    return fadeEdges(normalize(d, 0.6), sr, 0.0003);
  },
  dial(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.05, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(13);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = (rand() * 2 - 1) * Math.exp(-t * 1200) + Math.sin(2 * Math.PI * 3600 * t) * Math.exp(-t * 200) * 0.3;
    }
    biquad(d, sr, 'highpass', 1500);
    return fadeEdges(normalize(d, 0.45), sr, 0.0003);
  },
  lever(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.9, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(14);
    for (let k = 0; k < 6; k++) {
      const s0 = Math.floor((0.05 + k * 0.055) * sr);
      for (let i = 0; i < 0.03 * sr && s0 + i < d.length; i++) {
        const t = i / sr;
        d[s0 + i] += (rand() * 2 - 1) * Math.exp(-t * 500) * 0.5;
      }
    }
    addClunk(d, sr, 0.42, 1, 15);
    return normalize(d, 0.85);
  },
  clunk(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 1.4, 1);
    const d = buf.getChannelData(0);
    addClunk(d, sr, 0.0, 1, 21);
    return normalize(d, 0.9);
  },
  latch(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 1.0, 1);
    const d = buf.getChannelData(0);
    addClunk(d, sr, 0.0, 0.7, 22, 1.6);
    return normalize(d, 0.85);
  },
  thud(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 1.8, 1);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = Math.sin(2 * Math.PI * (60 - 25 * Math.min(1, t * 3)) * t) * Math.exp(-t * 3.5);
    }
    addRing(d, sr, 0.02, [143, 377, 611, 1022], 1.4, 0.12, 31);
    return normalize(d, 0.8);
  },
  hiss(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 3.2, 2);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const rand = mulberry32(40 + c);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = (rand() * 2 - 1) * Math.min(1, t * 12) * Math.exp(-t * 0.9);
      }
      biquad(d, sr, 'highpass', 1600);
      biquad(d, sr, 'lowpass', 9000);
      normalize(d, 0.55);
    }
    return buf;
  },
  rcs(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.35, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(41);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = (rand() * 2 - 1) * Math.min(1, t * 200) * Math.exp(-t * 14);
    }
    biquad(d, sr, 'bandpass', 2600, 0.7);
    return normalize(d, 0.5);
  },
  alarm(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 2.0, 1);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const f = Math.floor(t / 0.25) % 2 === 0 ? 880 : 660;
      const sq = Math.sign(Math.sin(2 * Math.PI * f * t));
      const gate = (t % 0.25) < 0.22 ? 1 : 0;
      d[i] = sq * gate * 0.3;
    }
    biquad(d, sr, 'lowpass', 2600);
    return fadeEdges(d, sr);
  },
  foot_metal(ctx, variant = 0) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.5, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(50 + variant * 7);
    for (let i = 0; i < 0.05 * sr; i++) d[i] += (rand() * 2 - 1) * Math.exp(-(i / sr) * 90);
    biquad(d, sr, 'lowpass', 2200);
    const jitter = 1 + (rand() - 0.5) * 0.12;
    addRing(d, sr, 0.004, [312 * jitter, 811 * jitter, 1460 * jitter, 2290 * jitter], 0.22, 0.32, 51 + variant);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] += Math.sin(2 * Math.PI * 95 * t) * Math.exp(-t * 30) * 0.5;
    }
    return normalize(d, 0.7);
  },
  foot_concrete(ctx, variant = 0) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.3, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(60 + variant * 7);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const scuff = t > 0.02 ? Math.exp(-(t - 0.02) * 40) * 0.5 : 0;
      d[i] = (rand() * 2 - 1) * (Math.exp(-t * 120) + scuff) + Math.sin(2 * Math.PI * 80 * t) * Math.exp(-t * 35) * 0.7;
    }
    biquad(d, sr, 'lowpass', 1500 + variant * 150);
    return normalize(d, 0.55);
  },
  foot_dirt(ctx, variant = 0) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.45, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(70 + variant * 13);
    const grains = 14 + Math.floor(rand() * 8);
    for (let g = 0; g < grains; g++) {
      const s0 = Math.floor((0.01 + rand() * 0.16) * sr);
      const len = Math.floor((0.004 + rand() * 0.012) * sr);
      const amp = 0.3 + rand() * 0.7;
      for (let i = 0; i < len && s0 + i < d.length; i++) d[s0 + i] += (rand() * 2 - 1) * amp * (1 - i / len);
    }
    biquad(d, sr, 'bandpass', 1300, 0.6);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] += Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t * 25) * 0.5;
    }
    return normalize(d, 0.6);
  },
  jolt(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 2.6, 2);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const rand = mulberry32(80 + c);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = Math.sin(2 * Math.PI * (48 - 18 * Math.min(1, t)) * t) * Math.exp(-t * 2.2) + (rand() * 2 - 1) * Math.exp(-t * 3) * 0.6;
      }
      biquad(d, sr, 'lowpass', 380);
      addRing(d, sr, 0.03, [97, 233, 389, 702], 1.8, 0.08, 82 + c);
      normalize(d, 0.95);
    }
    return buf;
  },
  creak(ctx, variant = 0) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 1.8, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(90 + variant);
    let phase = 0;
    const f0 = 70 + rand() * 60;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const env = Math.sin(Math.min(1, t / 1.8) * Math.PI) ** 2;
      const f = f0 * (1 + 0.25 * Math.sin(t * 9 + rand() * 0.2) + 0.4 * t);
      phase += (2 * Math.PI * f) / sr;
      const stick = Math.sin(phase) > 0.6 ? 1 : 0.15; // stick-slip buzz
      d[i] = (Math.sin(phase) * 0.4 + stick * (rand() * 2 - 1) * 0.3) * env;
    }
    biquad(d, sr, 'bandpass', 420, 0.9);
    return normalize(d, 0.5);
  },
  geiger(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 0.012, 1);
    const d = buf.getChannelData(0);
    const rand = mulberry32(99);
    for (let i = 0; i < d.length; i++) d[i] = (rand() * 2 - 1) * Math.exp(-(i / sr) * 900);
    biquad(d, sr, 'highpass', 2500);
    return normalize(d, 0.8);
  },
  boom(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 3.5, 2);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const rand = mulberry32(110 + c);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = (rand() * 2 - 1) * Math.min(1, t * 300) * Math.exp(-t * 1.6) + Math.sin(2 * Math.PI * 38 * t) * Math.exp(-t * 1.2) * 0.8;
      }
      biquad(d, sr, 'lowpass', 520);
      normalize(d, 0.95);
    }
    return buf;
  },
  elevator(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 5, 2);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const rand = mulberry32(120 + c);
      let ph = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.8) * Math.min(1, (5 - t) / 1.2);
        const f = 92 + 14 * Math.min(1, t / 1.5);
        ph += (2 * Math.PI * f) / sr;
        d[i] = ((ph / Math.PI) % 2 - 1) * 0.3 * env + (rand() * 2 - 1) * 0.12 * env;
      }
      biquad(d, sr, 'lowpass', 900);
      normalize(d, 0.6);
    }
    return buf;
  },
  heartbeat(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 1.0, 1);
    const d = buf.getChannelData(0);
    for (const [at, amp] of [[0, 1], [0.24, 0.7]]) {
      const s0 = Math.floor(at * sr);
      for (let i = 0; i < 0.25 * sr && s0 + i < d.length; i++) {
        const t = i / sr;
        d[s0 + i] += Math.sin(2 * Math.PI * 46 * t) * Math.exp(-t * 18) * amp;
      }
    }
    return normalize(d, 0.8);
  },
  dust(ctx) {
    const sr = ctx.sampleRate;
    const buf = buffer(ctx, 4, 2);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const rand = mulberry32(130 + c);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = (rand() * 2 - 1) * Math.min(1, t * 2) * Math.exp(-t * 0.7);
      }
      biquad(d, sr, 'highpass', 2800);
      normalize(d, 0.35);
    }
    return buf;
  },
};

function tones(ctx, list, gain = 0.3, decay = 0) {
  const sr = ctx.sampleRate;
  const end = Math.max(...list.map(([, s, dur]) => s + dur)) + 0.05;
  const buf = buffer(ctx, end, 1);
  const d = buf.getChannelData(0);
  for (const [f, s, dur] of list) {
    const s0 = Math.floor(s * sr);
    const n = Math.floor(dur * sr);
    for (let i = 0; i < n && s0 + i < d.length; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.005) * Math.min(1, (dur - t) / 0.008) * (decay ? Math.exp(-t * decay) : 1);
      d[s0 + i] += Math.sin(2 * Math.PI * f * t) * env * gain;
    }
  }
  return buf;
}

function addClunk(d, sr, at, amp, seed, pitch = 1) {
  const rand = mulberry32(seed);
  const s0 = Math.floor(at * sr);
  for (let i = 0; s0 + i < d.length && i < sr * 1.0; i++) {
    const t = i / sr;
    const f = (135 - 85 * Math.min(1, t * 4)) * pitch;
    d[s0 + i] += (Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) + (rand() * 2 - 1) * Math.exp(-t * 70) * 0.7) * amp;
  }
  addRing(d, sr, at + 0.002, [212 * pitch, 541 * pitch, 977 * pitch, 1630 * pitch], 0.7, 0.18 * amp, seed + 1);
}

function addRing(d, sr, at, partials, decay, amp, seed) {
  const rand = mulberry32(seed);
  const s0 = Math.floor(at * sr);
  partials.forEach((f, k) => {
    const ph = rand() * Math.PI * 2;
    const dk = (4 + k * 3) / decay;
    for (let i = 0; s0 + i < d.length; i++) {
      const t = i / sr;
      const e = Math.exp(-t * dk);
      if (e < 0.001) break;
      d[s0 + i] += Math.sin(2 * Math.PI * f * t + ph) * e * amp / (1 + k * 0.6);
    }
  });
}

/** Build every one-shot (and footstep variants) once. */
export function buildOneShots(ctx) {
  const out = new Map();
  // Many voices return their (mono) channel data rather than the buffer; wrap those.
  const asBuffer = (v) => {
    if (v && typeof v.getChannelData === 'function') return v;
    const b = ctx.createBuffer(1, Math.max(1, v.length), ctx.sampleRate);
    b.copyToChannel(v, 0);
    return b;
  };
  for (const [name, fn] of Object.entries(ONE_SHOTS)) {
    if (name.startsWith('foot_') || name === 'creak') {
      for (let v = 0; v < 4; v++) out.set(`${name}_${v}`, asBuffer(fn(ctx, v)));
    } else {
      out.set(name, asBuffer(fn(ctx)));
    }
  }
  return out;
}

/**
 * "Distant radio chatter": unintelligible, voice-like bursts — a buzz source
 * through two moving formants, chopped into syllables and phrases, then band-
 * limited like a handheld radio. Loops for ~14 s.
 */
export function chatterBuffer(ctx, seed = 21) {
  const sr = ctx.sampleRate;
  const buf = buffer(ctx, 14, 1);
  const d = buf.getChannelData(0);
  const rand = mulberry32(seed);
  let t = 0.4;
  while (t < 13.2) {
    const phrase = 0.8 + rand() * 2.2;
    const f0 = 105 + rand() * 70;
    let s = t;
    while (s < t + phrase) {
      const syl = 0.07 + rand() * 0.16;
      const fa = 350 + rand() * 600;
      const fb = 1100 + rand() * 1400;
      const s0 = Math.floor(s * sr);
      const n = Math.floor(syl * sr);
      const seg = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const f = f0 * (1 + 0.04 * Math.sin(i / sr * 30));
        ph += (2 * Math.PI * f) / sr;
        seg[i] = ((ph / Math.PI) % 2 - 1) * 0.6 + (rand() * 2 - 1) * 0.25;
      }
      const a = biquad(seg.slice(), sr, 'bandpass', fa, 3);
      const b = biquad(seg.slice(), sr, 'bandpass', fb, 4);
      for (let i = 0; i < n && s0 + i < d.length; i++) {
        const env = Math.sin((i / n) * Math.PI);
        d[s0 + i] += (a[i] + b[i] * 0.6) * env;
      }
      s += syl + rand() * 0.05;
    }
    t += phrase + 0.6 + rand() * 1.8;
  }
  biquad(d, sr, 'highpass', 420);
  biquad(d, sr, 'lowpass', 3000);
  for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * 2.5);
  normalize(d, 0.5);
  return buf;
}
