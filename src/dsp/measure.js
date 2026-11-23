// Measurement helpers shared by the test suite, the offline renderer and the
// browser UI. All measurements read the actual sample array.

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

// Windowed Goertzel power at an arbitrary (non-bin) frequency.
export function goertzelPower(signal, freq, sr, from = 0, to = signal.length) {
  const n = to - from;
  if (n <= 1) return 0;
  const w = (2 * Math.PI * freq) / sr;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const s0 = signal[from + i] * win + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n);
}

// Amplitude of a sinusoid at freq, measured over [from, to).
export function amplitudeAt(signal, freq, sr, from = 0, to = signal.length) {
  let a = 0;
  let b = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const t = (i - from) / sr;
    a += signal[i] * Math.cos(2 * Math.PI * freq * t);
    b += signal[i] * Math.sin(2 * Math.PI * freq * t);
    n++;
  }
  return n ? (2 * Math.hypot(a, b)) / n : 0;
}

export function estimateFreq(signal, sr, fmin = 40, fmax = 4000, from = 0, to = signal.length) {
  let best = fmin;
  let bestP = -Infinity;
  const coarse = Math.max(0.5, (fmax - fmin) / 800);
  for (let f = fmin; f <= fmax; f += coarse) {
    const p = goertzelPower(signal, f, sr, from, to);
    if (p > bestP) {
      bestP = p;
      best = f;
    }
  }
  let fine = best;
  let fineP = bestP;
  for (let f = best - coarse; f <= best + coarse; f += coarse / 8) {
    const p = goertzelPower(signal, f, sr, from, to);
    if (p > fineP) {
      fineP = p;
      fine = f;
    }
  }
  return fine;
}

export function envelope(signal, sr, winSec = 0.005) {
  const w = Math.max(1, Math.round(winSec * sr));
  const values = [];
  for (let i = 0; i < signal.length; i += w) {
    values.push(rms(signal, i, Math.min(signal.length, i + w)));
  }
  return { values, stepSec: w / sr };
}

export function onsetTimeSec(signal, sr, thresholdRatio = 0.1) {
  const env = envelope(signal, sr);
  const max = Math.max(...env.values);
  if (!(max > 0)) return null;
  const th = max * thresholdRatio;
  for (let i = 0; i < env.values.length; i++) {
    if (env.values[i] >= th) return i * env.stepSec;
  }
  return null;
}

export function lastAboveTimeSec(signal, sr, thresholdRatio = 0.05) {
  const env = envelope(signal, sr);
  const max = Math.max(...env.values);
  if (!(max > 0)) return null;
  const th = max * thresholdRatio;
  for (let i = env.values.length - 1; i >= 0; i--) {
    if (env.values[i] >= th) return Math.min(signal.length / sr, (i + 1) * env.stepSec);
  }
  return null;
}

// Evidence block derived only from the output samples and the input length.
export function sampleEvidence(input, output, sr, expectedRatio = null) {
  const inputOnset = onsetTimeSec(input, sr);
  const outputOnset = onsetTimeSec(output, sr);
  const inputEnd = lastAboveTimeSec(input, sr);
  const outputEnd = lastAboveTimeSec(output, sr);
  return {
    inputSamples: input.length,
    outputSamples: output.length,
    inputSeconds: input.length / sr,
    outputSeconds: output.length / sr,
    sampleCountPreserved: output.length === input.length,
    inputOnsetSec: inputOnset,
    outputOnsetSec: outputOnset,
    onsetShiftSec:
      inputOnset !== null && outputOnset !== null ? outputOnset - inputOnset : null,
    inputEndSec: inputEnd,
    outputEndSec: outputEnd,
    endShiftSec: inputEnd !== null && outputEnd !== null ? outputEnd - inputEnd : null,
    outputPeak: peak(output),
    outputRms: rms(output),
    expectedRatio,
  };
}
