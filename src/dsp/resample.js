// Band-limited windowed-sinc resampler.
//
// resampleStep(input, step, outLength):
//   output[i] = band-limited interpolation of input at position i * step.
//   step = read-speed. step > 1 reads faster -> output pitch is multiplied by
//   step and the output contains outLength samples. The anti-alias cutoff is
//   1/step of Nyquist when step > 1. This is the final pitch-shift stage: the
//   caller passes step = ratio and outLength = inputLength, so the sample
//   count is exactly preserved.
//
// resampleByRatio(input, ratio): ordinary resampling with output length
//   round(input.length * ratio) (used by tests/utilities, not by the kernel).

const ZERO_CROSSINGS = 16;

function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function blackman(x) {
  const ax = Math.abs(x);
  if (ax >= 1) return 0;
  const t = 0.5 * (ax + 1);
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

function kernel(d, cutoff) {
  const x = cutoff * d;
  return cutoff * sinc(x) * blackman(x / ZERO_CROSSINGS);
}

export function resampleStep(input, step, outLength, startSample = 0) {
  const n = input.length;
  const out = new Float64Array(outLength);
  if (n === 0 || outLength === 0) return out;
  if (step === 1 && startSample === 0) {
    const m = Math.min(n, outLength);
    for (let i = 0; i < m; i++) out[i] = input[i];
    return out;
  }
  const cutoff = Math.min(1, 1 / step);
  const support = ZERO_CROSSINGS / cutoff;

  for (let i = 0; i < outLength; i++) {
    const center = startSample + i * step;
    const k0 = Math.ceil(center - support);
    const k1 = Math.floor(center + support);
    let acc = 0;
    let wsum = 0;
    for (let k = k0; k <= k1; k++) {
      if (k < 0 || k >= n) continue;
      const h = kernel(center - k, cutoff);
      acc += input[k] * h;
      wsum += h;
    }
    out[i] = Math.abs(wsum) > 1e-12 ? acc / wsum : 0;
  }
  return out;
}

export function resampleByRatio(input, ratio) {
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const step = 1 / ratio;
  const n = input.length;
  const out = new Float64Array(outLength);
  if (n === 0) return out;
  const cutoff = Math.min(1, ratio);
  const support = ZERO_CROSSINGS / cutoff;
  for (let i = 0; i < outLength; i++) {
    const center = i / ratio;
    let acc = 0;
    let wsum = 0;
    for (let k = Math.ceil(center - support); k <= Math.floor(center + support); k++) {
      if (k < 0 || k >= n) continue;
      const h = kernel(center - k, cutoff);
      acc += input[k] * h;
      wsum += h;
    }
    out[i] = Math.abs(wsum) > 1e-12 ? acc / wsum : 0;
  }
  return out;
}

export function toFloat32(a) {
  return a instanceof Float32Array ? a : Float32Array.from(a);
}
