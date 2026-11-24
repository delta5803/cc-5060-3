// Compatibility measurements for the fixture library.
//
// Central idea: the two failure modes maintainers care about are independent
// and must never be conflated.
//
//   * Fixed delay  — the whole output is uniformly late/early relative to the
//     reference. Measured by aligning cumulative energy envelopes; a pitch
//     drift cannot move this number, and a delay cannot move the pitch number.
//   * Frequency drift — partials glide away from their targets over time.
//     Measured as the slope of cents-error versus time per partial; a uniform
//     delay is invisible to it because frequency is shift-invariant.
//
// Everything here reads a real sample array. Callers are expected to hand in
// samples parsed back from a written WAV (see compat-check.mjs), so the
// numbers describe what actually shipped, not what the kernel held in memory.

import { estimateFreq, rms } from './measure.js';

// ---------------------------------------------------------------- envelopes --

export function cumulativeEnergy(signal) {
  const n = signal.length;
  const out = new Float64Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += signal[i] * signal[i];
    out[i + 1] = acc;
  }
  return out;
}

// Lag (in samples) by which `output` is delayed relative to `reference`.
// Positive lag: output[i] ~ reference[i - lag]. Coarse-to-fine search.
export function measureFixedDelaySamples(output, reference, sampleRate, opts = {}) {
  const maxLagMs = opts.maxLagMs ?? 60;
  const stride = opts.stride ?? 16;
  const n = Math.min(output.length, reference.length);
  if (n < 8) {
    return { lagSamples: null, lagMs: null, objective: null, correlation: null, searchedMs: maxLagMs };
  }
  const co = cumulativeEnergy(output);
  const cr = cumulativeEnergy(reference);
  const maxLag = Math.max(1, Math.round((maxLagMs / 1000) * sampleRate));
  const guard = Math.min(256, Math.floor(n / 4));

  const objective = (lag) => {
    let err = 0;
    let cnt = 0;
    for (let i = guard; i <= n; i += stride) {
      const j = i - lag;
      if (j < 0 || j > n) continue;
      const d = co[i] - cr[j];
      err += d * d;
      cnt++;
    }
    return cnt ? err / cnt : Infinity;
  };

  let bestLag = 0;
  let bestErr = Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag += 8) {
    const e = objective(lag);
    if (e < bestErr) { bestErr = e; bestLag = lag; }
  }
  const lo = Math.max(-maxLag, bestLag - 8);
  const hi = Math.min(maxLag, bestLag + 8);
  for (let lag = lo; lag <= hi; lag++) {
    const e = objective(lag);
    if (e < bestErr) { bestErr = e; bestLag = lag; }
  }

  // Normalised correlation of the energy derivative at the chosen lag, so a
  // caller can tell "clean alignment" from "no usable alignment".
  let dot = 0, na = 0, nb = 0;
  for (let i = guard; i <= n; i += stride) {
    const j = i - bestLag;
    if (j < 0 || j > n) continue;
    const a = co[i] - co[Math.max(0, i - stride)];
    const b = cr[j] - cr[Math.max(0, j - stride)];
    dot += a * b; na += a * a; nb += b * b;
  }
  return {
    lagSamples: bestLag,
    lagMs: (bestLag / sampleRate) * 1000,
    objective: bestErr,
    correlation: na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : null,
    searchedMs: maxLagMs,
  };
}

// --------------------------------------------------------------- drift ------

// Per-partial cents-vs-time slope over sustained windows. Windows are analysed
// where the source is steady: `skipStartSec` after the onset and
// `skipEndSec` before the end.
export function measureFrequencyDrift(output, sampleRate, targets, opts = {}) {
  const winSamples = opts.windowSamples ?? 4096;
  const hopSamples = opts.hopSamples ?? Math.max(1, winSamples >> 2);
  const skipStartSec = opts.skipStartSec ?? 0.12;
  const skipEndSec = opts.skipEndSec ?? 0.06;
  const onsetSample = opts.onsetSample ?? 0;
  const from = Math.max(0, Math.round(onsetSample + skipStartSec * sampleRate));
  const to = output.length - Math.round(skipEndSec * sampleRate);
  const partials = [];
  if (to - from < winSamples) {
    return { partials, windows: 0, maxAbsCents: null, maxAbsSlope: null, note: 'too short for drift windows' };
  }
  for (const t of targets) {
    const target = t.targetHz ?? t.hz;
    const cents = [];
    const times = [];
    for (let i = from; i + winSamples <= to; i += hopSamples) {
      const f = estimateFreq(output.subarray(i, i + winSamples), sampleRate, target * 0.88, target * 1.12);
      times.push((i + winSamples / 2) / sampleRate);
      cents.push(1200 * Math.log2(f / target));
    }
    const n = times.length;
    const mt = times.reduce((a, b) => a + b, 0) / n;
    const mc = cents.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (times[i] - mt) * (cents[i] - mc); den += (times[i] - mt) ** 2; }
    const slope = den > 0 ? num / den : 0;
    partials.push({
      sourceHz: t.sourceHz ?? target,
      targetHz: target,
      windows: n,
      meanCents: mc,
      slopeCentsPerSec: slope,
      rangeCents: Math.max(...cents) - Math.min(...cents),
      minCents: Math.min(...cents),
      maxCents: Math.max(...cents),
    });
  }
  const maxAbsCents = Math.max(...partials.map((p) => Math.max(Math.abs(p.maxCents), Math.abs(p.minCents))));
  const maxAbsSlope = Math.max(...partials.map((p) => Math.abs(p.slopeCentsPerSec)));
  return { partials, windows: partials[0]?.windows ?? 0, maxAbsCents, maxAbsSlope };
}

// -------------------------------------------------------------- onsets ------

// First *effective* attack in a sample array. Uses a short-time RMS envelope
// and a causal baseline so a slice that starts inside a sustain reports the
// next re-attack, not the first non-zero energy. Returns a sample index or null.
export function firstEffectiveOnsetSample(signal, sampleRate, opts = {}) {
  const blockMs = opts.blockMs ?? 2;
  const riseFactor = opts.riseFactor ?? 2.2;
  const floorRel = opts.floorRel ?? 0.05;
  const w = Math.max(1, Math.round((blockMs / 1000) * sampleRate));
  const blocks = [];
  for (let i = 0; i < signal.length; i += w) blocks.push(rms(signal, i, Math.min(signal.length, i + w)));
  const count = blocks.length;
  if (!count) return null;
  const globalMax = Math.max(...blocks);
  if (!(globalMax > 0)) return null;
  const floor = floorRel * globalMax;

  // Causal baseline = median of the preceding ~15 blocks. Block 0 has no
  // history, so its baseline is its own value: a slice that merely *starts*
  // loud is not an onset. An onset is a rise above what preceded it.
  for (let b = 0; b < count; b++) {
    const lo = Math.max(0, b - 15);
    let baseline;
    if (b === 0) baseline = blocks[0];
    else {
      const prev = blocks.slice(lo, b).sort((x, y) => x - y);
      baseline = prev[prev.length >> 1];
    }
    const value = blocks[b];
    if (value < floor) continue;
    if (!(value >= riseFactor * baseline + floor * 0.5)) continue;
    // Refine inside the block to the first sample over half the block level.
    const s = b * w;
    const e = Math.min(signal.length, s + w);
    const level = 0.5 * value;
    for (let k = s; k < e; k++) if (Math.abs(signal[k]) >= level) return k;
    return s;
  }
  return null;
}

// ------------------------------------------------------- difference segments --

// Contiguous output regions where two backends differ meaningfully.
//
// Comparison is on a short-time difference envelope, not per sample: two
// phase-different outputs agree at zero-crossings and disagree between them, so
// a per-sample threshold produces hundreds of one-sample fragments. A region is
// "out of tolerance" when the local RMS difference stays above `threshold` for
// at least `minMs`.
//
// Each segment reports its strongest sample and the matching *input* sample,
// so a maintainer can jump from "they differ here" back to the source audio.
export function differenceSegments(a, b, input, opts = {}) {
  const threshold = opts.threshold ?? 0.02;
  const sampleRate = opts.sampleRate ?? 44100;
  const envSamples = Math.max(1, Math.round((opts.envMs ?? 10) / 1000 * sampleRate));
  const minMs = opts.minMs ?? 20;
  const n = Math.min(a.length, b.length);
  if (n === 0) return { segments: [], count: 0, threshold, envMs: opts.envMs ?? 10, minMs };

  // Sliding-window RMS difference.
  const diff = new Float64Array(n);
  for (let i = 0; i < n; i++) diff[i] = Math.abs(a[i] - b[i]);
  const sqPrefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sqPrefix[i + 1] = sqPrefix[i] + diff[i] * diff[i];
  const winRms = new Float64Array(n);
  const half = envSamples >> 1;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    winRms[i] = Math.sqrt((sqPrefix[hi] - sqPrefix[lo]) / (hi - lo));
  }

  const minSamples = Math.max(1, Math.round((minMs / 1000) * sampleRate));
  const segments = [];
  let start = -1;
  let peakIdx = -1;
  let peakEnv = 0;
  let peakVal = 0;
  const flush = (endExclusive) => {
    if (start < 0) return;
    if (endExclusive - start >= minSamples) {
      let sumSq = 0;
      for (let i = start; i < endExclusive; i++) sumSq += diff[i] * diff[i];
      segments.push({
        startSample: start,
        endSample: endExclusive,
        startSec: start / sampleRate,
        endSec: endExclusive / sampleRate,
        peakSample: peakIdx,
        peakSec: peakIdx / sampleRate,
        peakAbsDiff: peakVal,
        rmsDiff: Math.sqrt(sumSq / (endExclusive - start)),
        inputSample: input && peakIdx >= 0 && peakIdx < input.length ? peakIdx : null,
        inputValue: input && peakIdx >= 0 && peakIdx < input.length ? input[peakIdx] : null,
        inputWindow: input && peakIdx >= 0 && peakIdx < input.length
          ? [Math.max(0, peakIdx - 4), Math.min(input.length, peakIdx + 5)]
          : null,
      });
    }
    start = -1; peakIdx = -1; peakEnv = 0; peakVal = 0;
  };
  let above = false;
  for (let i = 0; i < n; i++) {
    const inTol = winRms[i] > threshold;
    // Extend the segment boundary by the smoothing half-width so segment edges
    // are not eaten by the envelope window.
    if (inTol && !above) { start = Math.max(0, i - half); peakIdx = i; peakEnv = winRms[i]; peakVal = diff[i]; }
    // Track the strongest point by the *smoothed* envelope, not the raw sample
    // difference: a raw peak can fall on an input zero-crossing, which is a
    // useless place to jump back to in the source audio.
    if (inTol && winRms[i] > peakEnv) { peakEnv = winRms[i]; peakIdx = i; peakVal = diff[i]; }
    if (!inTol && above) flush(Math.min(n, Math.max(start, i - half)));
    above = inTol;
  }
  if (above) flush(n);
  return {
    segments,
    count: segments.length,
    threshold,
    envMs: opts.envMs ?? 10,
    minMs,
    totalDifferingSamples: segments.reduce((s, x) => s + (x.endSample - x.startSample), 0),
  };
}

// ------------------------------------------------------ legacy window config --

// Legacy configs may carry any of several historical key spellings. Reading is
// deliberately tolerant: the point is to learn which presets a maintainer can
// still trust, and to report the ones that cannot be resolved rather than
// silently substituting defaults.
const FIELD_ALIASES = {
  frameSize: ['frameSize', 'fftSize', 'windowSize', 'window', 'N'],
  overlap: ['overlap', 'hopDiv', 'osamp', 'overlapFactor'],
  phaseLock: ['phaseLock', 'identityPhaseLock', 'phase_locked', 'lockPhase'],
  autoFrameSize: ['autoFrameSize', 'adaptiveFrameSize', 'auto_frame', 'adaptive'],
  transientMode: ['transientMode', 'transient', 'attackMode', 'mode'],
  transientThreshold: ['transientThreshold', 'threshold', 'resetThreshold'],
};

function pick(obj, aliases) {
  for (const key of aliases) if (obj[key] !== undefined) return { value: obj[key], key };
  return { value: undefined, key: null };
}

export function readLegacyPresets(doc) {
  // Accept either { presets: [...] } or a bare array, or { presets: { id: cfg } }.
  const issues = [];
  let raw = doc;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    if (doc.presets !== undefined) raw = doc.presets;
    else if (doc.windowPresets !== undefined) raw = doc.windowPresets;
  }
  const list = [];
  if (Array.isArray(raw)) {
    raw.forEach((cfg, i) => list.push({ id: cfg.id ?? cfg.name ?? `preset-${i}`, cfg }));
  } else if (raw && typeof raw === 'object') {
    for (const [id, cfg] of Object.entries(raw)) list.push({ id: cfg.id ?? id, cfg });
  } else {
    issues.push({ id: null, reason: 'no preset collection found' });
  }

  const presets = list.map(({ id, cfg }) => {
    const fs = pick(cfg, FIELD_ALIASES.frameSize);
    const ov = pick(cfg, FIELD_ALIASES.overlap);
    const pl = pick(cfg, FIELD_ALIASES.phaseLock);
    const af = pick(cfg, FIELD_ALIASES.autoFrameSize);
    const tm = pick(cfg, FIELD_ALIASES.transientMode);
    const tt = pick(cfg, FIELD_ALIASES.transientThreshold);
    const resolved = {
      id,
      frameSize: fs.value,
      overlap: ov.value,
      phaseLock: pl.value,
      autoFrameSize: af.value,
      transientMode: tm.value,
      transientThreshold: tt.value,
      sourceKeys: {
        frameSize: fs.key, overlap: ov.key, phaseLock: pl.key,
        autoFrameSize: af.key, transientMode: tm.key, transientThreshold: tt.key,
      },
      readable: true,
      issues: [],
    };
    if (!(Number.isFinite(resolved.frameSize) && resolved.frameSize > 0)) {
      resolved.readable = false;
      resolved.issues.push('frameSize missing or invalid (looked for ' + FIELD_ALIASES.frameSize.join('/') + ')');
    }
    if (resolved.overlap !== undefined && !(Number.isFinite(resolved.overlap) && resolved.overlap >= 1)) {
      resolved.readable = false;
      resolved.issues.push('overlap invalid');
    }
    if (!resolved.readable) issues.push({ id, reason: resolved.issues.join('; ') });
    return resolved;
  });
  return { presets, issues, sourceSchema: doc && doc.schema ? doc.schema : null };
}

export function readLegacyProjects(doc) {
  let raw = doc && (doc.projects ?? doc.sessions);
  if (!raw) return { projects: [], issues: [{ id: null, reason: 'no projects/sessions collection' }] };
  const list = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([id, p]) => ({ id, ...p }));
  return {
    projects: list.map((p) => {
      const sampleRate = p.sampleRate ?? null;
      const playFromSample = p.playFromSample ?? (
        p.playFromSec !== undefined && sampleRate ? Math.round(p.playFromSec * sampleRate) : 0
      );
      const markerSample = p.markerSample ?? (
        (p.markerSec ?? p.timeMarkerSec ?? p.firstOnsetSec) !== undefined && sampleRate
          ? Math.round((p.markerSec ?? p.timeMarkerSec ?? p.firstOnsetSec) * sampleRate)
          : null
      );
      return {
        id: p.id ?? p.name ?? null,
        name: p.name ?? null,
        sampleRate,
        sourceId: p.sourceId ?? p.clip ?? p.source ?? null,
        presetId: p.presetId ?? p.preset ?? p.windowPreset ?? null,
        transposeSemitones: p.transposeSemitones ?? p.semitones ?? 0,
        playFromSample,
        playFromSec: sampleRate ? playFromSample / sampleRate : (p.playFromSec ?? 0),
        markerSample,
        markerSec: markerSample !== null && sampleRate ? markerSample / sampleRate : null,
        raw: p,
      };
    }),
    issues: [],
  };
}

// Decide what a legacy project render proves.
//
// The question a maintainer asks is: "when I change a window, which old presets
// still work?" A legacy project that plays from the middle shows an onset that
// does not line up with its time marker. That symptom has two *different*
// causes, and conflating them is exactly the mistake this function prevents:
//
//   1. The preset could not be read. We then do not even know which window the
//      old project used, so the onset comparison is meaningless and must not be
//      reported as a kernel problem. Status: `preset-read-failed`.
//
//   2. The preset read fine, but the project started mid-stream, so the first
//      analysis window is zero-padded on the left (no history). The resulting
//      onset displacement is an artefact of the cold start, not a delay in the
//      kernel. Status: `first-window-missing-history`.
//
// Only when the preset is readable, the render had real pre-roll, and the
// measured delay/drift still exceed tolerance do we call it a regression.
//
// `evidence` fields:
//   presetReadable            boolean. If false, nothing else is judged.
//   presetIssues              list of parse problems (for the failure report).
//   playFromSample            where the project started, in source samples.
//   hasPreRoll                whether the measured render had real history.
//   markerSample              project time marker, in source samples.
//   coldOnsetSample           first effective onset of the cold render, in
//                             source-timeline samples (or null).
//   warmOnsetSample           same for a render with real pre-roll (or null).
//   coldFirstWindowRmsDiff    RMS difference cold-vs-warm over the first window.
//   delayMs, driftCentsPerSec measured on the render that has history.
//   tolerances                { onsetSamples, delayMs, driftCentsPerSec }.
export function classifyProjectCompatibility(evidence) {
  if (!evidence.presetReadable) {
    return {
      status: 'preset-read-failed',
      detail:
        'The legacy preset could not be read, so the window used by the old project is unknown. ' +
        'Onset alignment is not evidence about this preset; fix the config keys first.',
      presetIssues: evidence.presetIssues || [],
      onsetAligned: null,
    };
  }

  const tol = evidence.tolerances || {};
  const onsetTol = tol.onsetSamples ?? 64;
  const marker = evidence.markerSample;
  const coldErr = evidence.coldOnsetSample != null && marker != null
    ? evidence.coldOnsetSample - marker
    : null;
  const warmErr = evidence.warmOnsetSample != null && marker != null
    ? evidence.warmOnsetSample - marker
    : null;
  const onsetAligned = coldErr !== null ? Math.abs(coldErr) <= onsetTol : null;

  // Structural fact: the project started partway into the source and the
  // measured render had no pre-roll. The first window necessarily lacks
  // history; that, not the kernel, explains any onset displacement.
  if (evidence.playFromSample > 0 && evidence.hasPreRoll === false) {
    const warmConfirms = warmErr !== null && Math.abs(warmErr) <= onsetTol;
    return {
      status: 'first-window-missing-history',
      detail:
        'The project starts mid-stream with no pre-roll, so the first analysis window is ' +
        'zero-padded on the left. ' +
        (warmConfirms
          ? `With real pre-roll the onset lands within ${warmErr} samples of the marker, so the `
            + 'displacement is missing history, not a kernel delay.'
          : 'This is an expected cold-start artefact, not a preset or kernel fault.'),
      onsetAligned,
      coldErrorSamples: coldErr,
      warmErrorSamples: warmErr,
      coldFirstWindowRmsDiff: evidence.coldFirstWindowRmsDiff ?? null,
      firstWindowSamples: evidence.firstWindowSamples ?? null,
    };
  }

  const delayBad = evidence.delayMs !== undefined && tol.delayMs !== undefined
    ? Math.abs(evidence.delayMs) > tol.delayMs
    : false;
  const driftBad = evidence.driftCentsPerSec !== undefined && tol.driftCentsPerSec !== undefined
    ? Math.abs(evidence.driftCentsPerSec) > tol.driftCentsPerSec
    : false;

  if (delayBad || driftBad) {
    return {
      status: 'delay-drift-regression',
      detail:
        (delayBad ? `Fixed delay ${evidence.delayMs.toFixed(2)} ms exceeds ${tol.delayMs} ms. ` : '') +
        (driftBad ? `Drift ${evidence.driftCentsPerSec.toFixed(2)} cents/s exceeds ${tol.driftCentsPerSec}.` : ''),
      onsetAligned,
      coldErrorSamples: coldErr,
      warmErrorSamples: warmErr,
    };
  }

  if (onsetAligned === false) {
    return {
      status: 'onset-misaligned',
      detail: `Onset is off by ${coldErr} samples with pre-roll present and no delay/drift excess.`,
      onsetAligned,
      coldErrorSamples: coldErr,
      warmErrorSamples: warmErr,
    };
  }

  return {
    status: 'ok',
    detail: onsetAligned
      ? `Onset aligns to the marker within ${coldErr} samples; delay and drift within tolerance.`
      : 'Preset read, delay and drift within tolerance.',
    onsetAligned,
    coldErrorSamples: coldErr,
    warmErrorSamples: warmErr,
  };
}

// ------------------------------------------------------ composites ----------

export function evaluateBackend({
  output, reference, input, sampleRate, targets, onsetSample,
  expectedDelaySamples = null, tolerances = {}, driftOpts = {},
}) {
  const delay = measureFixedDelaySamples(output, reference, sampleRate);
  const drift = measureFrequencyDrift(output, sampleRate, targets, { onsetSample, ...driftOpts });
  const compensatedDelay = delay.lagSamples !== null && expectedDelaySamples !== null
    ? delay.lagSamples - expectedDelaySamples
    : null;
  const delayTolSamples = tolerances.delayMs !== undefined
    ? Math.round((tolerances.delayMs / 1000) * sampleRate)
    : null;
  const delayOk = compensatedDelay === null || delayTolSamples === null
    ? null
    : Math.abs(compensatedDelay) <= delayTolSamples;
  const driftOk = drift.maxAbsSlope === null || tolerances.driftCentsPerSec === undefined
    ? null
    : drift.maxAbsSlope <= tolerances.driftCentsPerSec;
  const centsOk = drift.maxAbsCents === null || tolerances.driftCents === undefined
    ? null
    : drift.maxAbsCents <= tolerances.driftCents;
  return {
    fixedDelay: {
      measuredSamples: delay.lagSamples,
      measuredMs: delay.lagMs,
      expectedSamples: expectedDelaySamples,
      compensatedSamples: compensatedDelay,
      toleranceSamples: delayTolSamples,
      ok: delayOk,
      correlation: delay.correlation,
      method: 'cumulative-energy alignment',
    },
    frequencyDrift: {
      ...drift,
      toleranceCentsPerSec: tolerances.driftCentsPerSec ?? null,
      toleranceCents: tolerances.driftCents ?? null,
      ok: driftOk !== null && centsOk !== null ? driftOk && centsOk : (driftOk ?? centsOk),
      method: 'per-partial cents-vs-time slope',
    },
    inputSamples: input ? input.length : null,
  };
}
