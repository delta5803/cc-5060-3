// Backend registry for the compatibility harness.
//
// Two backends implement the same contract:
//
//   process(signal, sampleRate, options) -> { output, meta, trace }
//
// They are genuinely different algorithms, not the same kernel with different
// flags:
//
//   'peak-locked'  the production kernel: STFT -> peak tracking -> identity
//                  phase locking -> weighted overlap-add -> band-limited
//                  resampling. (Re-exported from transpose.js.)
//
//   'plain-vocoder' a legacy-style per-bin phase vocoder: no peak identity, no
//                  phase locking, no transient reset. Every bin propagates its
//                  own instantaneous frequency. It keeps duration and pitch but
//                  smears intra-partial phase, which is exactly the kind of
//                  regression the compatibility library is meant to catch.
//
// Callers never assume a backend is the production one; the harness reads the
// registry so that adding or replacing a backend is a local change.

import { processAudio, semitonesToRatio, LIMITS } from './transpose.js';
import { FFT, nextPow2 } from './fft.js';
import { hann } from './window.js';
import { resampleStep } from './resample.js';
import { TAU, wrapPhase } from './peaks.js';

function kerr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function peakLockedBackend(signal, sampleRate, options = {}) {
  return processAudio(signal, sampleRate, options);
}

// Plain per-bin phase vocoder. Same external contract and the same final
// band-limited resampling stage, so its output length matches the input exactly.
export function plainVocoderBackend(signal, sampleRate, options = {}) {
  if (!(signal instanceof Float32Array) && !(signal instanceof Float64Array)) {
    throw kerr('BAD_INPUT', 'Expected a mono Float32/Float64 array');
  }
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) {
    throw kerr('BAD_SAMPLE_RATE', 'Sample rate must be positive');
  }
  const ratio = options.ratio ?? semitonesToRatio(options.semitones ?? 0);
  if (!Number.isFinite(ratio) || ratio < LIMITS.ratioMin || ratio > LIMITS.ratioMax) {
    throw kerr('RATIO_OUT_OF_RANGE', 'Pitch ratio outside supported range');
  }
  const frameSize = nextPow2(options.frameSize ?? LIMITS.frameSize);
  const N = frameSize;
  const Ha = Math.floor(N / LIMITS.overlap);
  const half = N >> 1;
  const L = signal.length;
  const Hs = Ha * ratio;

  if (L === 0) {
    return {
      output: new Float32Array(0),
      meta: {
        backend: 'plain-vocoder',
        ratio,
        semitones: 12 * Math.log2(ratio),
        cents: 1200 * Math.log2(ratio),
        sampleRate,
        inputLength: 0,
        inputDurationSec: 0,
        outputLength: 0,
        outputDurationSec: 0,
        durationPreserved: false,
        frameSize: N,
        analysisHop: Ha,
        synthesisHop: Hs,
        stretchFactor: ratio,
        framesAnalysed: 0,
        framesSynthesised: 0,
        onsetEvents: 0,
        resetCount: 0,
        phaseLock: false,
        algorithmicLatencySamples: N,
        algorithmicLatencySec: N / sampleRate,
        autoFrameSize: { applied: false, baseFrameSize: N, chosenFrameSize: N },
        trimRule: 'Empty input produces empty output.',
      },
      trace: { backend: 'plain-vocoder', frames: [], algorithmicLatencySamples: N },
    };
  }

  const win = hann(N);
  const fft = new FFT(N);
  const first = -Math.ceil(N / (2 * Ha)) - 1;
  const last = Math.ceil((L + N / 2) / Ha) + 1;

  const support = 16;
  const origin = N + support + 8;
  const stretchedLength = origin + Math.ceil((L + N) * ratio) + N + support + 8;
  const stretched = new Float64Array(stretchedLength);
  const norm = new Float64Array(stretchedLength);

  const prevPhase = new Float64Array(half + 1);
  const sumPhase = new Float64Array(half + 1);
  let havePrev = false;
  let frameCount = 0;

  const bins = new Float64Array(N);
  const nyq = TAU / 2;
  const expectedPerHop = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) expectedPerHop[k] = (TAU * k * Ha) / N;

  for (let f = first; f <= last; f++) {
    const start = f * Ha - N / 2;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      bins[i] = idx >= 0 && idx < L ? signal[idx] * win[i] : 0;
    }
    for (let i = 0; i < N; i++) re[i] = bins[i];
    fft.transform(re, im, false);

    const mag = new Float64Array(half + 1);
    const phase = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    const outRe = new Float64Array(N);
    const outIm = new Float64Array(N);
    for (let k = 1; k < half; k++) {
      if (!havePrev) {
        sumPhase[k] = phase[k];
      } else {
        const dphi = wrapPhase(phase[k] - prevPhase[k] - expectedPerHop[k]);
        const instOmega = (TAU * k) / N + dphi / Ha;
        sumPhase[k] += instOmega * Hs;
      }
      // Keep the accumulated phase bounded for numerical stability.
      if (sumPhase[k] > 1e6 || sumPhase[k] < -1e6) sumPhase[k] = wrapPhase(sumPhase[k]);
      const a = mag[k];
      outRe[k] = a * Math.cos(sumPhase[k]);
      outIm[k] = a * Math.sin(sumPhase[k]);
      outRe[N - k] = outRe[k];
      outIm[N - k] = -outIm[k];
    }
    for (let k = 0; k <= half; k++) prevPhase[k] = phase[k];
    havePrev = true;

    const placed = Math.round(f * Hs - N / 2) + origin;
    fft.transform(outRe, outIm, true);
    for (let i = 0; i < N; i++) {
      const idx = placed + i;
      if (idx < 0 || idx >= stretchedLength) continue;
      stretched[idx] += outRe[i] * win[i];
      norm[idx] += win[i] * win[i];
    }
    frameCount++;
  }

  for (let i = 0; i < stretchedLength; i++) {
    stretched[i] = norm[i] > 1e-9 ? stretched[i] / norm[i] : 0;
  }
  const shifted = resampleStep(stretched, ratio, L, origin);
  const output = Float32Array.from(shifted);

  return {
    output,
    meta: {
      backend: 'plain-vocoder',
      ratio,
      semitones: 12 * Math.log2(ratio),
      cents: 1200 * Math.log2(ratio),
      sampleRate,
      inputLength: L,
      inputDurationSec: L / sampleRate,
      outputLength: output.length,
      outputDurationSec: output.length / sampleRate,
      durationPreserved: output.length === L,
      frameSize: N,
      analysisHop: Ha,
      synthesisHop: Hs,
      stretchFactor: ratio,
      framesAnalysed: frameCount,
      framesSynthesised: frameCount,
      onsetEvents: 0,
      resetCount: 0,
      phaseLock: false,
      algorithmicLatencySamples: N,
      algorithmicLatencySec: N / sampleRate,
      autoFrameSize: { applied: false, baseFrameSize: N, chosenFrameSize: N },
      trimRule: 'Per-bin phase vocoder, then band-limited resampling emitting exactly inputLength samples.',
    },
    trace: { backend: 'plain-vocoder', frames: [], algorithmicLatencySamples: N },
  };
}

const REGISTRY = new Map([
  ['peak-locked', { id: 'peak-locked', label: '峰锁定相位声码器', process: peakLockedBackend }],
  ['plain-vocoder', { id: 'plain-vocoder', label: '逐箱相位声码器（旧）', process: plainVocoderBackend }],
]);

export function listBackends() {
  return [...REGISTRY.values()].map((b) => ({ id: b.id, label: b.label }));
}

export function getBackend(id) {
  const b = REGISTRY.get(id);
  if (!b) throw kerr('UNKNOWN_BACKEND', `Unknown backend '${id}'`);
  return b;
}

export function processWithBackend(id, signal, sampleRate, options = {}) {
  return getBackend(id).process(signal, sampleRate, options);
}
