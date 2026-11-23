// Window functions and short-time Fourier transform helpers.

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// Periodic Hann analysis/synthesis pair. Perfect reconstruction for 75% overlap
// when analysis and synthesis windows are identical.
export function hannPeriodic(n) {
  return hann(n);
}

// Builds an analysis window whose main lobe is narrow enough that a peak bin is
// dominated by one partial, while keeping side lobes low (-31 dB Hann).
export function buildWindow(n) {
  return hann(n);
}

export function rms(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function peakAbs(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

export function energy(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return s;
}
