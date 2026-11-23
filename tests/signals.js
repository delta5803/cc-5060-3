// Synthetic test material and measurement helpers (no external deps).

export const SR = 44100;

export function sineTone({ freq, seconds, sr = SR, amp = 0.5, phase = 0 }) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(phase + (2 * Math.PI * freq * i) / sr);
  return out;
}

export function dualTone({ freqs, seconds, sr = SR, amps = null }) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < freqs.length; j++) {
      const a = amps ? amps[j] : 0.3 / freqs.length;
      out[i] += a * Math.sin((2 * Math.PI * freqs[j] * i) / sr);
    }
  }
  return out;
}

// A note with a sharp attack and a sustained body, optional release.
export function pluckedTone({ freq, seconds, sr = SR, amp = 0.5, attackSec = 0.008, decay = 1.8 }) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const attackN = Math.max(1, Math.round(attackSec * sr));
  for (let i = 0; i < n; i++) {
    const env = i < attackN ? i / attackN : Math.exp(-decay * ((i - attackN) / sr));
    out[i] = amp * env * (
      Math.sin((2 * Math.PI * freq * i) / sr) +
      0.35 * Math.sin((2 * Math.PI * 2 * freq * i) / sr) +
      0.15 * Math.sin((2 * Math.PI * 3 * freq * i) / sr)
    );
  }
  return out;
}

// Phrase: quiet lead-in, attack, sustained note, gap, second attack.
export function phraseWithAttacks({ freq, seconds, sr = SR, amp = 0.5 }) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const t = (i) => i / sr;
  const events = [
    { start: 0.15, dur: 0.55, f: freq },
    { start: 0.85, dur: 0.6, f: freq * 1.5 },
  ];
  for (let i = 0; i < n; i++) {
    const time = t(i);
    let s = 0;
    for (const ev of events) {
      if (time < ev.start || time >= ev.start + ev.dur) continue;
      const local = time - ev.start;
      const attack = 0.006;
      const env = local < attack
        ? local / attack
        : Math.exp(-1.6 * (local - attack)) * (1 - Math.min(1, Math.max(0, (local - (ev.dur - 0.05)) / 0.05)));
      s += amp * env * (
        Math.sin(2 * Math.PI * ev.f * time) +
        0.3 * Math.sin(2 * Math.PI * 2 * ev.f * time) +
        0.12 * Math.sin(2 * Math.PI * 3 * ev.f * time)
      );
    }
    out[i] = s;
  }
  return out;
}

// Same-pitch note with a re-attack in the middle: the partial track survives,
// so reset/continue policies differ only in phase handling.
export function reattackTone({ seconds = 1.4, sr = SR, freq = 220 } = {}) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const attackAt = 0.6;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let env;
    if (t < 0.15) env = 0;
    else if (t < attackAt) env = 0.5 * (0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 0.9 * t)));
    else if (t < attackAt + 0.002) env = 0.02;
    else env = 0.5 * (0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 0.9 * t)));
    out[i] =
      env *
      (Math.sin(2 * Math.PI * freq * t) +
        0.5 * Math.sin(2 * Math.PI * 2 * freq * t) +
        0.3 * Math.sin(2 * Math.PI * 3 * freq * t));
  }
  return out;
}

// Concatenate with silence, helper for padding tests.
export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function silence(seconds, sr = SR) {
  return new Float32Array(Math.round(seconds * sr));
}

// ------------------------------------------------------------ measurement --

export function rms(signal, from = 0, to = signal.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += signal[i] * signal[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function peak(signal) {
  let m = 0;
  for (let i = 0; i < signal.length; i++) m = Math.max(m, Math.abs(signal[i]));
  return m;
}

// Windowed DFT magnitude at an arbitrary (non-bin) frequency; used to verify
// the transposed frequency without relying on FFT bins alone.
export function goertzelPower(signal, freq, sr = SR, from = 0, to = signal.length) {
  const n = to - from;
  if (n <= 1) return 0;
  const w = (2 * Math.PI * freq) / sr;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const x = signal[from + i] * win;
    s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power / (n * n);
}

export function estimateFreq(signal, sr = SR, fmin = 40, fmax = 4000, from = 0, to = signal.length) {
  // Coarse-to-fine peak search on Goertzel power; robust enough for our tests.
  let best = fmin;
  let bestP = -Infinity;
  const coarseStep = 2;
  for (let f = fmin; f <= fmax; f += coarseStep) {
    const p = goertzelPower(signal, f, sr, from, to);
    if (p > bestP) {
      bestP = p;
      best = f;
    }
  }
  let fineBest = best;
  let fineP = bestP;
  for (let f = best - coarseStep; f <= best + coarseStep; f += 0.1) {
    const p = goertzelPower(signal, f, sr, from, to);
    if (p > fineP) {
      fineP = p;
      fineBest = f;
    }
  }
  return fineBest;
}

// Envelope follower for onset / duration checks.
export function envelope(signal, sr = SR, winSec = 0.005) {
  const w = Math.max(1, Math.round(winSec * sr));
  const out = [];
  for (let i = 0; i < signal.length; i += w) {
    out.push(rms(signal, i, Math.min(signal.length, i + w)));
  }
  return { values: out, stepSec: w / sr };
}

export function onsetTimeSec(signal, sr = SR, thresholdRatio = 0.1) {
  const env = envelope(signal, sr);
  const max = Math.max(...env.values);
  if (max <= 0) return null;
  const th = max * thresholdRatio;
  for (let i = 0; i < env.values.length; i++) {
    if (env.values[i] >= th) return i * env.stepSec;
  }
  return null;
}

export function lastAboveTimeSec(signal, sr = SR, thresholdRatio = 0.05) {
  const env = envelope(signal, sr);
  const max = Math.max(...env.values);
  if (max <= 0) return null;
  const th = max * thresholdRatio;
  for (let i = env.values.length - 1; i >= 0; i--) {
    if (env.values[i] >= th) return Math.min(signal.length / sr, (i + 1) * env.stepSec);
  }
  return null;
}
