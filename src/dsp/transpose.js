// Musical pitch transposition kernel.
//
// Signal chain (explicit so every stage can be traced and audited):
//
//   input
//     -> STFT analysis (periodic Hann, analysis hop Ha = N/4)
//     -> spectral peak picking + parabolic refinement + peak tracking
//     -> phase-vocoder time scaling by S (synthesis hop Hs = S * Ha)
//          * identity phase locking: each bin that belongs to a peak's region
//            receives that peak's propagated phase plus the bin's own analysed
//            inter-bin phase offset. Phase relationships inside a partial stay
//            coherent, which removes intra-voice scatter.
//          * transient handling: onset reliability chooses between phase reset
//            (sharp attack) and phase continuation (stable sustained pitch).
//     -> inverse STFT / weighted overlap-add
//     -> band-limited windowed-sinc resampling, reading at step S and
//        emitting exactly the input's sample count
//     -> transposed audio with identical duration.
//
// Duration is preserved by sample count. No playback-rate change is involved.

import { FFT, nextPow2 } from './fft.js';
import { hann } from './window.js';
import { detectPeaks, refineInstantaneousFrequency, PeakTracker, wrapPhase, TAU } from './peaks.js';
import { resampleStep } from './resample.js';

export class KernelError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    this.detail = detail;
  }
}

export const LIMITS = Object.freeze({
  ratioMin: 0.5,
  ratioMax: 2.0,
  semitonesMin: -12,
  semitonesMax: 12,
  semitoneStep: 0.01,
  frameSize: 2048,
  overlap: 4,
  transientModes: ['auto', 'continue', 'reset', 'always'],
  transientThresholdDefault: 0.5,
  maxRegionBins: 6,
  maxPeaks: 48,
});

export const KERNEL_STATE = Object.freeze({
  version: '1.0.0',
  engine: 'peak-locked phase vocoder + band-limited resampler',
  durationPreserved: true,
  playbackRateUsed: false,
});

export function capabilities() {
  return {
    ...KERNEL_STATE,
    ratio: { min: LIMITS.ratioMin, max: LIMITS.ratioMax, continuous: true, step: 0.0001 },
    semitones: { min: LIMITS.semitonesMin, max: LIMITS.semitonesMax, step: LIMITS.semitoneStep },
    transientModes: [...LIMITS.transientModes],
    transientThreshold: { min: 0, max: 1, step: 0.01, default: LIMITS.transientThresholdDefault },
    phaseLock: true,
    frameSize: LIMITS.frameSize,
    overlap: LIMITS.overlap,
    autoFrameSize: true,
    notes: [
      'Duration is preserved by sample count; playbackRate is never used.',
      'Upshifting band-limits content above Nyquist/ratio before resampling.',
      'Partials closer than about 1.5 FFT bins merge into one component.',
      'Mono processing; multichannel must be processed channel by channel.',
    ],
    limitations: [
      'Transposition range is +/-12 semitones (ratio 0.5..2.0).',
      'Onsets closer than 40 ms are merged into one reset decision.',
      'Strongly inharmonic material may lose partial identity and drift.',
      'At +12 st broad-band material is band-limited and sounds darker.',
    ],
  };
}

export function semitonesToRatio(semitones) {
  return Math.pow(2, semitones / 12);
}

export function validateOptions(opts = {}) {
  const ratio = opts.ratio ?? semitonesToRatio(opts.semitones ?? 0);
  if (!Number.isFinite(ratio)) {
    throw new KernelError('BAD_RATIO', 'Pitch ratio must be a finite number', { ratio });
  }
  if (ratio < LIMITS.ratioMin || ratio > LIMITS.ratioMax) {
    throw new KernelError('RATIO_OUT_OF_RANGE', 'Pitch ratio outside supported range', {
      ratio,
      min: LIMITS.ratioMin,
      max: LIMITS.ratioMax,
    });
  }
  const mode = opts.transientMode ?? 'auto';
  if (!LIMITS.transientModes.includes(mode)) {
    throw new KernelError('BAD_TRANSIENT_MODE', 'Unknown transient mode', {
      mode,
      allowed: LIMITS.transientModes,
    });
  }
  const threshold = opts.transientThreshold ?? LIMITS.transientThresholdDefault;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new KernelError('BAD_THRESHOLD', 'Transient threshold must be within [0, 1]', { threshold });
  }
  return { ratio, mode, threshold };
}

function round(x, d) {
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}

function median(values) {
  if (values.length === 0) return 0;
  const a = Array.from(values).sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
}

function frameRangeFor(length, hop, frameSize) {
  // Frames are centred on f*hop. Cover input time [-N/2, length + N/2] so the
  // onset and the tail are seen by full-strength windows. Negative indices are
  // legitimate: their right half overlaps the start of the signal.
  const first = -Math.ceil(frameSize / (2 * hop)) - 1;
  const last = Math.ceil((length + frameSize / 2) / hop) + 1;
  return { first, last, count: last - first + 1 };
}

// ---------------------------------------------------------------- analysis --

function analyseFrames(signal, sampleRate, opt, range) {
  const N = opt.frameSize;
  const Ha = opt.hop;
  const half = N >> 1;
  const fft = new FFT(N);
  const win = hann(N);
  const { first, last } = range;
  const tracker = new PeakTracker({ toleranceHz: Math.max(10, sampleRate / N) });

  const count = last - first + 1;
  const flux = new Float64Array(count);
  const rms = new Float64Array(count);
  const out = [];

  let prevMag = null;
  let prevRe = null;
  let prevIm = null;

  for (let f = first; f <= last; f++) {
    // Frame f is centred on sample f*Ha; parts outside the signal are zero.
    const start = f * Ha - N / 2;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    let e = 0;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      const s = idx >= 0 && idx < signal.length ? signal[idx] : 0;
      re[i] = s * win[i];
      e += s * s;
    }
    const slot = f - first;
    rms[slot] = Math.sqrt(e / N);
    fft.transform(re, im, false);
    const mag = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);

    if (prevMag) {
      let num = 0;
      let den = 0;
      for (let k = 1; k < half; k++) {
        const d = mag[k] - prevMag[k];
        if (d > 0) num += d * d;
        den += mag[k] * mag[k];
      }
      flux[slot] = den > 0 ? Math.sqrt(num / den) : 0;
    }

    let peaks = detectPeaks(mag, re, im, N, sampleRate, {
      relFloor: opt.peakRelFloor,
      maxPeaks: opt.maxPeaks,
    });
    refineInstantaneousFrequency(peaks, prevMag ? { mag: prevMag, re: prevRe, im: prevIm } : null, Ha, N);
    peaks = tracker.update(peaks);

    out.push({ index: f, slot, start, re, im, mag, peaks });
    prevMag = mag;
    prevRe = re;
    prevIm = im;
  }
  return { frames: out, flux, rms, win, fft, N, Ha, half, first, last, count };
}

// ---------------------------------------------------------------- onsets ----

export function detectOnsets(flux, rms, hop, sampleRate, firstFrame = 0) {
  const F = flux.length;
  if (F === 0) return { events: [], reliability: new Float64Array(0), baseline: new Float64Array(0) };

  // 3-tap smoothing suppresses single-frame ripple from two beating partials.
  const sm = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    sm[f] =
      (flux[Math.max(0, f - 1)] + 2 * flux[f] + flux[Math.min(F - 1, f + 1)]) / 4;
  }

  // Causal baseline: the flux level *before* the candidate. An attack is a
  // rise relative to what preceded it, so a steady chord's beating ripple
  // never qualifies, while a real note entry after a quiet passage does.
  const lookback = Math.max(6, Math.round((0.28 * sampleRate) / hop));
  const baseline = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    const lo = Math.max(0, f - lookback);
    const hi = Math.max(lo, f - 3);
    baseline[f] = median(sm.subarray(lo, hi + 1));
  }
  const globalMax = Math.max(...sm, 1e-12);
  const globalRms = Math.max(...rms, 1e-12);
  const floorFlux = 0.02 * globalMax;

  const threshold = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    threshold[f] = Math.max(2.2 * baseline[f] + floorFlux, 2.5 * floorFlux);
  }

  const reliability = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    reliability[f] = Math.max(0, Math.min(1, (sm[f] - threshold[f]) / (0.5 * globalMax)));
  }

  const minGapFrames = Math.max(1, Math.round((0.04 * sampleRate) / hop));
  const candidates = [];
  for (let f = 1; f < F - 1; f++) {
    if (!(sm[f] >= sm[f - 1] && sm[f] >= sm[f + 1])) continue;
    if (sm[f] < threshold[f]) continue;
    if (sm[f] < 0.12 * globalMax) continue; // not salient in its own right
    if (rms[f] < 0.02 * globalRms) continue; // silence
    const prevRms = rms[f - 1];
    if (rms[f] < 0.7 * prevRms) continue; // release tail, not an attack

    const post = [];
    for (let j = f + 1; j <= Math.min(F - 1, f + 4); j++) post.push(rms[j]);
    const postMean = post.length ? post.reduce((a, b) => a + b, 0) / post.length : 0;
    const sustained = postMean >= 0.15 * Math.max(rms[f], 1e-9);
    candidates.push({
      slot: f,
      frame: f + firstFrame,
      timeSec: Math.max(0, ((f + firstFrame) * hop) / sampleRate),
      flux: sm[f],
      reliability: reliability[f] * (sustained ? 1 : 0.4),
      sustained,
      threshold: threshold[f],
    });
  }

  // Collapse candidates closer than the minimum gap, keeping the stronger.
  candidates.sort((a, b) => a.slot - b.slot);
  const events = [];
  for (const c of candidates) {
    const last = events[events.length - 1];
    if (last && c.slot - last.slot < minGapFrames) {
      if (c.reliability > last.reliability) events[events.length - 1] = c;
      continue;
    }
    events.push(c);
  }
  return { events, reliability, baseline };
}

// ---------------------------------------------------------------- regions ---

function makeRegions(peaks, half, maxBins) {
  const regions = peaks.map((p) => {
    const centre = Math.max(1, Math.min(half - 1, Math.round(p.fracBin)));
    return { lo: Math.max(1, centre - maxBins), hi: Math.min(half - 1, centre + maxBins), peakBin: p.bin };
  });
  // Split disputed bins at the midpoint between adjacent peaks.
  for (let i = 1; i < peaks.length; i++) {
    const a = peaks[i - 1];
    const b = peaks[i];
    const mid = Math.floor((a.fracBin + b.fracBin) / 2);
    regions[i - 1].hi = Math.min(regions[i - 1].hi, mid);
    regions[i].lo = Math.max(regions[i].lo, mid + 1);
  }
  return regions;
}

// ---------------------------------------------------------------- core ------

function estimatePeakDensity(signal, sampleRate, opt) {
  // Run a light analysis and look for frames whose detected partials are
  // closer than a comfortable margin (about 1.5 bins at the base frame size)
  // but would be resolvable at the next size up. Returns the fraction of
  // strongly populated frames with such close neighbours.
  const N = opt.frameSize;
  const Ha = opt.hop;
  const half = N >> 1;
  const fft = new FFT(N);
  const win = hann(N);
  const range = frameRangeFor(signal.length, Ha, N);
  const step = Math.max(1, Math.floor(range.count / 24));
  let checked = 0;
  let crowded = 0;
  const binHz = sampleRate / N;
  for (let f = range.first; f <= range.last; f += step) {
    const start = f * Ha - N / 2;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    let e = 0;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      const s = idx >= 0 && idx < signal.length ? signal[idx] : 0;
      re[i] = s * win[i];
      e += s * s;
    }
    if (Math.sqrt(e / N) < 1e-4) continue;
    fft.transform(re, im, false);
    const mag = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);
    const peaks = detectPeaks(mag, re, im, N, sampleRate, {
      relFloor: opt.peakRelFloor,
      maxPeaks: opt.maxPeaks,
    });
    if (peaks.length < 3) continue;
    checked++;
    for (let i = 1; i < peaks.length; i++) {
      const gapBins = Math.abs(peaks[i].fracBin - peaks[i - 1].fracBin);
      // Unsafe at N but likely resolvable at 2N.
      if (gapBins > 1.0 && gapBins < 3.0) {
        crowded++;
        break;
      }
    }
  }
  return checked ? crowded / checked : 0;
}

export function processAudio(signal, sampleRate, options = {}) {
  if (!(signal instanceof Float32Array) && !(signal instanceof Float64Array)) {
    throw new KernelError('BAD_INPUT', 'Expected a mono Float32/Float64 array');
  }
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) {
    throw new KernelError('BAD_SAMPLE_RATE', 'Sample rate must be positive', { sampleRate });
  }
  const { ratio, mode, threshold } = validateOptions(options);

  const baseFrame = nextPow2(options.frameSize ?? LIMITS.frameSize);
  const baseOpt = {
    frameSize: baseFrame,
    hop: Math.floor(baseFrame / LIMITS.overlap),
    peakRelFloor: options.peakRelFloor ?? 1e-3,
    maxPeaks: options.maxPeaks ?? LIMITS.maxPeaks,
    maxRegionBins: options.maxRegionBins ?? LIMITS.maxRegionBins,
    phaseLock: options.phaseLock !== false,
  };

  if (signal.length === 0) {
    const meta = emptyMeta(ratio, sampleRate, baseFrame, baseOpt.hop, baseOpt.hop * ratio);
    return {
      output: new Float32Array(0),
      meta,
      trace: emptyTrace(ratio, sampleRate, baseFrame, baseOpt.hop, baseOpt.hop * ratio, mode, threshold),
    };
  }

  // Density adaptation: if partials are so close that the base frame cannot
  // resolve them, rerun with double the frame size. The chosen size is
  // reported back so callers are never misled about the resolution used.
  const denseFraction = options.autoFrameSize === false
    ? 0
    : estimatePeakDensity(signal, sampleRate, baseOpt);
  const adaptive = denseFraction >= 0.2 && options.autoFrameSize !== false;
  const frameSize = adaptive ? Math.min(16384, baseFrame * 2) : baseFrame;

  const opt = {
    ...baseOpt,
    frameSize,
    hop: Math.floor(frameSize / LIMITS.overlap),
  };
  const result = renderTransposition(signal, sampleRate, ratio, mode, threshold, opt);
  result.meta.autoFrameSize = {
    applied: adaptive,
    baseFrameSize: baseFrame,
    chosenFrameSize: frameSize,
    denseFrameFraction: round(denseFraction, 4),
    reason: adaptive
      ? 'Dense partial spacing detected; doubled frame size to separate partials.'
      : 'Base frame size resolves the detected partials.',
  };
  result.trace.autoFrameSize = result.meta.autoFrameSize;
  return result;
}

function renderTransposition(signal, sampleRate, ratio, mode, threshold, opt) {
  const N = opt.frameSize;
  const Ha = opt.hop;
  const half = N >> 1;
  const L = signal.length;
  const Hs = Ha * ratio;

  const range = frameRangeFor(L, Ha, N);
  const analysis = analyseFrames(signal, sampleRate, opt, range);
  const { frames, flux, rms, win, fft } = analysis;
  const onsetInfo = detectOnsets(flux, rms, Ha, sampleRate, analysis.first);
  const onsetByFrame = new Map(onsetInfo.events.map((e) => [e.frame, e]));

  // Stretched output. `ratio` is the stretch factor: frequency content remains
  // unchanged here; the final resampling stage performs the actual shift.
  const supportSamples = Math.ceil(16 / Math.min(1, 1 / ratio));
  const origin = N + supportSamples + 8; // buffer index of stretched time 0
  const stretchedLength = origin + Math.ceil((L + N) * ratio) + N + supportSamples + 8;
  const stretched = new Float64Array(stretchedLength);
  const norm = new Float64Array(stretchedLength);

  const trackState = new Map();
  const traceFrames = [];
  const resetEvents = [];
  let prevPhaseByBin = null;
  let prevCentre = null;
  let framesSynthesised = 0;

  for (const frame of frames) {
    const f = frame.index;
    const synthCentre = f * Hs;
    const placed = Math.round(synthCentre - N / 2) + origin;
    const hopDelta = prevCentre === null ? 0 : Math.round(synthCentre) - prevCentre;
    prevCentre = Math.round(synthCentre);
    const onset = onsetByFrame.get(f) || null;
    const reliability = onset ? onset.reliability : 0;
    let reset;
    if (mode === 'always') reset = true;
    else if (mode === 'continue') reset = false;
    else if (mode === 'reset') reset = !!onset;
    else reset = !!onset && reliability >= threshold;

    const { re, im, mag, peaks } = frame;
    const regions = makeRegions(peaks, half, opt.maxRegionBins);

    const yRe = new Float64Array(N);
    const yIm = new Float64Array(N);
    const phaseByBin = new Float64Array(half + 1);
    const owner = new Int16Array(half + 1).fill(-1);

    const partials = [];

    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      const previous = trackState.get(p.trackId);
      const wasNew = !previous;
      const target = reset || wasNew ? p.phase : previous.phase + previous.omega * hopDelta;
      trackState.set(p.trackId, { phase: target, omega: p.instOmega, lastFrame: f });

      const region = regions[i];
      const association = [];
      for (let k = region.lo; k <= region.hi; k++) {
        if (owner[k] >= 0) {
          const other = peaks[owner[k]];
          if (other.amp >= p.amp) continue;
        }
        owner[k] = i;
        const amp = mag[k];
        const phi = Math.atan2(im[k], re[k]);
        const offset = wrapPhase(phi - p.phase);
        const phase = opt.phaseLock ? target + offset : phi;
        if (k !== 0 && k !== half) {
          yRe[k] += amp * Math.cos(phase);
          yIm[k] += amp * Math.sin(phase);
        }
        phaseByBin[k] = phase;
        if (association.length < 6) {
          association.push({
            bin: k,
            inputPhase: round(phi, 5),
            phaseOffset: round(offset, 5),
            usedPhase: round(phase, 5),
            amp: round(mag[k], 6),
          });
        }
      }

      partials.push({
        trackId: p.trackId,
        sourceHz: round(p.hz, 3),
        sourceBin: round(p.bin, 3),
        instHz: round((p.instOmega / TAU) * sampleRate, 3),
        finalHz: round(p.hz * ratio, 3),
        analysisPhase: round(p.phase, 5),
        targetPhase: round(target, 5),
        reset: reset || wasNew,
        region: [region.lo, region.hi],
        association,
      });
    }

    // Bins outside every region: frequency-preserving phase continuation.
    for (let k = 1; k < half; k++) {
      if (owner[k] >= 0) continue;
      const phi = Math.atan2(im[k], re[k]);
      const phase = reset || !prevPhaseByBin
        ? phi
        : prevPhaseByBin[k] + ((TAU * k) / N) * hopDelta;
      const amp = mag[k];
      yRe[k] += amp * Math.cos(phase);
      yIm[k] += amp * Math.sin(phase);
      phaseByBin[k] = phase;
    }

    yIm[0] = 0;
    yRe[0] = 0;
    for (let k = 1; k < half; k++) {
      yRe[N - k] = yRe[k];
      yIm[N - k] = -yIm[k];
    }
    yIm[half] = 0;

    fft.transform(yRe, yIm, true);
    for (let i = 0; i < N; i++) {
      const idx = placed + i;
      if (idx >= stretchedLength) break;
      stretched[idx] += yRe[i] * win[i];
      norm[idx] += win[i] * win[i];
    }

    let lockedBins = 0;
    for (let k = 1; k < half; k++) if (owner[k] >= 0) lockedBins++;

    traceFrames.push({
      frame: f,
      timeSec: round((f * Ha) / sampleRate, 6),
      placedSample: placed,
      flux: round(flux[frame.slot], 6),
      onsetReliability: round(reliability, 5),
      onset: !!onset,
      sustained: onset ? onset.sustained : false,
      reset,
      phaseLockedBins: lockedBins,
      partials,
    });
    if (reset) {
      resetEvents.push({ frame: f, timeSec: round((f * Ha) / sampleRate, 6), reliability: round(reliability, 5) });
    }

    prevPhaseByBin = phaseByBin;
    framesSynthesised++;

    for (const [id, st] of trackState) {
      if (f - st.lastFrame > 4) trackState.delete(id);
    }
  }

  const stretchSpan = Math.round((L + N) * ratio) + 2 * supportSamples;
  for (let i = 0; i < stretchedLength; i++) {
    stretched[i] = norm[i] > 1e-9 ? stretched[i] / norm[i] : 0;
  }

  const shifted = resampleStep(stretched, ratio, L, origin);
  const output = Float32Array.from(shifted);

  const meta = {
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
    stretchedLength: stretchSpan,
    framesAnalysed: frames.length,
    framesSynthesised,
    onsetEvents: onsetInfo.events.length,
    resetCount: resetEvents.length,
    algorithmicLatencySamples: N,
    algorithmicLatencySec: N / sampleRate,
    resamplerSupportSamples: supportSamples,
    trimRule:
      'Output is emitted for exactly inputLength samples from the resampled stretched signal. The resampler is zero-phase (symmetric kernel, no group delay). Analysis zero-pads past the end, so tail events are included; the final samples are covered by the last frames.',
    transientMode: mode,
    transientThreshold: threshold,
    phaseLock: opt.phaseLock,
  };

  return {
    output,
    meta,
    trace: {
      ratio,
      sampleRate,
      frameSize: N,
      analysisHop: Ha,
      synthesisHop: Hs,
      transientMode: mode,
      transientThreshold: threshold,
      resets: resetEvents,
      frames: traceFrames,
    },
  };
}

function emptyMeta(ratio, sampleRate, N, Ha, Hs) {
  return {
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
    stretchedLength: 0,
    framesAnalysed: 0,
    framesSynthesised: 0,
    onsetEvents: 0,
    resetCount: 0,
    algorithmicLatencySamples: N,
    algorithmicLatencySec: N / sampleRate,
    resamplerSupportSamples: 0,
    trimRule: 'Empty input produces empty output.',
    transientMode: 'auto',
    transientThreshold: LIMITS.transientThresholdDefault,
    phaseLock: true,
  };
}

function emptyTrace(ratio, sampleRate, N, Ha, Hs, mode, threshold) {
  return {
    ratio,
    sampleRate,
    frameSize: N,
    analysisHop: Ha,
    synthesisHop: Hs,
    transientMode: mode,
    transientThreshold: threshold,
    resets: [],
    frames: [],
  };
}

// ------------------------------------------------------------- analysis API --

export function analyzeAudio(signal, sampleRate, options = {}) {
  const frameSize = nextPow2(options.frameSize ?? LIMITS.frameSize);
  const opt = {
    frameSize,
    hop: Math.floor(frameSize / LIMITS.overlap),
    peakRelFloor: options.peakRelFloor ?? 1e-3,
    maxPeaks: options.maxPeaks ?? LIMITS.maxPeaks,
  };
  const N = opt.frameSize;
  const Ha = opt.hop;
  const half = N >> 1;
  const L = signal.length;

  if (L === 0) {
    return {
      sampleRate,
      length: 0,
      durationSec: 0,
      frameSize: N,
      hop: Ha,
      frames: [],
      spectrogram: { frames: 0, bins: 0, maxFreqHz: sampleRate / 2, frameStride: 1, db: [] },
      onsets: [],
      tracks: [],
    };
  }

  const range = frameRangeFor(L, Ha, N);
  const { frames: raw, flux, rms } = analyseFrames(signal, sampleRate, opt, range);
  const onsetInfo = detectOnsets(flux, rms, Ha, sampleRate, range.first);

  const frames = raw.map((fr) => ({
    index: fr.index,
    timeSec: ((fr.index * Ha) / sampleRate),
    rms: rms[fr.slot],
    flux: flux[fr.slot],
    peaks: fr.peaks.map((p) => ({
      trackId: p.trackId,
      hz: round(p.hz, 3),
      bin: p.bin,
      amp: round(p.amp, 6),
      phase: round(p.phase, 5),
      instHz: round((p.instOmega / TAU) * sampleRate, 3),
    })),
  }));

  const targetBins = Math.min(320, half);
  const stepBin = Math.max(1, Math.floor(half / targetBins));
  const bins = Math.floor(half / stepBin);
  const frameStride = Math.max(1, Math.ceil(frames.length / 800));
  const rows = [];
  let peakDb = -160;
  for (let f = 0; f < frames.length; f += frameStride) {
    const mag = raw[f].mag;
    const row = [];
    for (let b = 0; b < bins; b++) {
      let m = 0;
      for (let j = 0; j < stepBin; j++) {
        const k = b * stepBin + j;
        if (k <= half) m = Math.max(m, mag[k]);
      }
      const db = 20 * Math.log10(m + 1e-9);
      row.push(db);
      if (db > peakDb) peakDb = db;
    }
    rows.push(row);
  }
  const floorDb = peakDb - 80;
  for (const row of rows) {
    for (let b = 0; b < row.length; b++) row[b] = Math.max(0, Math.min(1, (row[b] - floorDb) / 80));
  }

  const trackMap = new Map();
  for (const fr of frames) {
    for (const p of fr.peaks) {
      let t = trackMap.get(p.trackId);
      if (!t) {
        t = {
          trackId: p.trackId,
          firstTimeSec: fr.timeSec,
          lastTimeSec: fr.timeSec,
          minHz: p.hz,
          maxHz: p.hz,
          sumHz: 0,
          count: 0,
          maxAmp: 0,
        };
        trackMap.set(p.trackId, t);
      }
      t.lastTimeSec = fr.timeSec;
      t.minHz = Math.min(t.minHz, p.hz);
      t.maxHz = Math.max(t.maxHz, p.hz);
      t.sumHz += p.hz;
      t.count++;
      t.maxAmp = Math.max(t.maxAmp, p.amp);
    }
  }
  const tracks = [...trackMap.values()]
    .map((t) => ({
      trackId: t.trackId,
      firstTimeSec: round(t.firstTimeSec, 4),
      lastTimeSec: round(t.lastTimeSec, 4),
      meanHz: round(t.sumHz / t.count, 3),
      minHz: round(t.minHz, 3),
      maxHz: round(t.maxHz, 3),
      maxAmp: round(t.maxAmp, 6),
    }))
    .sort((a, b) => b.maxAmp - a.maxAmp);

  return {
    sampleRate,
    length: L,
    durationSec: L / sampleRate,
    frameSize: N,
    hop: Ha,
    frames,
    spectrogram: {
      frames: rows.length,
      bins,
      maxFreqHz: sampleRate / 2,
      frameStride,
      db: rows,
    },
    onsets: onsetInfo.events.map((e) => ({
      frame: e.frame,
      timeSec: round(e.timeSec, 6),
      reliability: round(e.reliability, 5),
      flux: round(e.flux, 6),
      sustained: e.sustained,
    })),
    tracks,
  };
}
