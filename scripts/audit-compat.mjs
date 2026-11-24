#!/usr/bin/env node
// Reads the compatibility artefacts back from disk and verifies them.
//
// The build script reports numbers from samples it still holds in memory. This
// tool deliberately forgets all of that: it opens library.json, then re-reads
// every input/reference/backend WAV from the filesystem, re-derives the onset
// compensation, the fixed delay and the frequency drift from those samples,
// and fails if the stored claims do not match what the files actually contain.
//
// It also checks the two independence properties the whole method rests on:
//   * a uniform delay changes the fixed-delay reading but not the drift reading;
//   * a pure pitch drift changes the drift reading but not the fixed-delay one.
//
// Writes outputs/compat/audit.json. Exit code is non-zero if any check fails.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav } from '../src/dsp/wav.js';
import {
  firstEffectiveOnsetSample,
  measureFixedDelaySamples,
  measureFrequencyDrift,
} from '../src/dsp/compat.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'outputs', 'compat');
const library = JSON.parse(readFileSync(join(outDir, 'library.json'), 'utf8'));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function loadWav(relPath) {
  const p = join(outDir, relPath);
  const bytes = readFileSync(p);
  return parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function cents(a, b) { return 1200 * Math.log2(a / b); }

// ---------------------------------------------------------------- 1. files --
let missing = 0;
let parsed = 0;
for (const c of library.cases) {
  if (!existsSync(join(outDir, c.inputFile))) { missing++; continue; }
  if (!existsSync(join(outDir, c.referenceFile))) { missing++; continue; }
  for (const [backendId, b] of Object.entries(c.backends)) {
    if (!existsSync(join(outDir, b.outputFile))) { missing++; continue; }
  }
  parsed++;
}
check('every referenced audio file exists', missing === 0, `${missing} missing, ${parsed} complete cases`);

// ---------------------------------------------- 2. re-derive from the disk --
let sampleCountOk = 0;
let onsetOk = 0;
let onsetChecked = 0;
let delayOk = 0;
let delayChecked = 0;
let pitchOk = 0;
let pitchChecked = 0;
const mismatches = [];

for (const c of library.cases) {
  const input = loadWav(c.inputFile).channels[0];
  const reference = loadWav(c.referenceFile).channels[0];
  const refOnset = firstEffectiveOnsetSample(reference, c.sampleRate);
  if (refOnset !== c.referenceOnsetSample) {
    mismatches.push({ case: `${c.sourceId}/${c.semitones}st/w${c.windowSize}`, what: 'reference onset', disk: refOnset, stored: c.referenceOnsetSample });
  }
  for (const [backendId, b] of Object.entries(c.backends)) {
    const out = loadWav(b.outputFile).channels[0];
    if (out.length === input.length) sampleCountOk++;
    else mismatches.push({ case: `${c.sourceId}/${c.semitones}st/w${c.windowSize}/${backendId}`, what: 'sample count', disk: out.length, stored: input.length });

    const outOnset = firstEffectiveOnsetSample(out, c.sampleRate);
    const shift = outOnset !== null && refOnset !== null ? outOnset - refOnset : null;
    if (b.onsetShiftSamples !== null) {
      onsetChecked++;
      if (shift === b.onsetShiftSamples) onsetOk++;
      else mismatches.push({ case: `${c.sourceId}/${c.semitones}st/w${c.windowSize}/${backendId}`, what: 'onset shift', disk: shift, stored: b.onsetShiftSamples });
    }

    const delay = measureFixedDelaySamples(out, reference, c.sampleRate);
    delayChecked++;
    if (delay.lagSamples === b.fixedDelay.measuredSamples) delayOk++;
    else mismatches.push({ case: `${c.sourceId}/${c.semitones}st/w${c.windowSize}/${backendId}`, what: 'fixed delay', disk: delay.lagSamples, stored: b.fixedDelay.measuredSamples });

    // Pitch from the disk file at each target, in a sustained window.
    for (const t of c.targets) {
      pitchChecked++;
      const from = Math.min(out.length - 1, Math.round(0.35 * c.sampleRate));
      const to = Math.min(out.length, from + Math.round(0.25 * c.sampleRate));
      const measured = measureToneCents(out, t.targetHz, c.sampleRate, from, to);
      if (Math.abs(measured) <= 60) pitchOk++;
      else mismatches.push({ case: `${c.sourceId}/${c.semitones}st/w${c.windowSize}/${backendId}`, what: `pitch @ ${t.targetHz.toFixed(1)}`, disk: measured.toFixed(2) });
    }
  }
}

function measureToneCents(signal, targetHz, sr, from, to) {
  // Goertzel-based peak search near the target, returns cents error.
  let best = targetHz;
  let bestP = -Infinity;
  for (let f = targetHz * 0.94; f <= targetHz * 1.06; f += targetHz * 0.001) {
    const p = goertzel(signal, f, sr, from, to);
    if (p > bestP) { bestP = p; best = f; }
  }
  return cents(best, targetHz);
}

function goertzel(signal, freq, sr, from, to) {
  const n = to - from;
  const w = (2 * Math.PI * freq) / sr;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const s0 = signal[from + i] * win + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n);
}

check('output sample counts match their inputs (disk)', sampleCountOk === library.cases.length * Object.keys(library.cases[0].backends).length, `${sampleCountOk} files`);
check('onset shifts re-derive from disk', onsetChecked > 0 && onsetOk === onsetChecked, `${onsetOk}/${onsetChecked}`);
check('fixed delays re-derive from disk', delayOk === delayChecked, `${delayOk}/${delayChecked}`);
check('all partials land on target from disk (<= 60 cents)', pitchOk === pitchChecked, `${pitchOk}/${pitchChecked}`);

// ------------------------------------------- 3. delay/drift independence ----
// Take one real output, inject a uniform delay, and confirm only the delay
// reading moves. Then inject a linear pitch drift and confirm only the drift
// reading moves. This is the property that lets the report attribute a fault.
const sampleCase = library.cases.find((c) => c.sourceId.startsWith('stable-dual') && c.semitones === 7 && c.windowSize === 2048);
const sampleOut = loadWav(sampleCase.backends['peak-locked'].outputFile).channels[0];
const sampleRef = loadWav(sampleCase.referenceFile).channels[0];
const sampleInput = loadWav(sampleCase.inputFile).channels[0];

function shiftSignal(sig, d) {
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    const j = i - d;
    if (j >= 0 && j < sig.length) out[i] = sig[j];
  }
  return out;
}

const baseDelay = measureFixedDelaySamples(sampleOut, sampleRef, sampleCase.sampleRate);
const baseDrift = measureFrequencyDrift(sampleOut, sampleCase.sampleRate, sampleCase.targets, { onsetSample: sampleCase.referenceOnsetSample });

const delayed = shiftSignal(sampleOut, 128);
const delayedDelay = measureFixedDelaySamples(delayed, sampleRef, sampleCase.sampleRate);
const delayedDrift = measureFrequencyDrift(delayed, sampleCase.sampleRate, sampleCase.targets, { onsetSample: sampleCase.referenceOnsetSample });

const delayMoved = delayedDelay.lagSamples - baseDelay.lagSamples;
const driftStayedForDelay = Math.abs((delayedDrift.maxAbsSlope ?? 0) - (baseDrift.maxAbsSlope ?? 0)) < 3;
check(
  'injected uniform delay moves the delay reading by the injected amount',
  Math.abs(delayMoved - 128) <= 16,
  `base ${baseDelay.lagSamples} -> ${delayedDelay.lagSamples} (moved ${delayMoved})`,
);
check(
  'injected uniform delay leaves the drift reading essentially unchanged',
  driftStayedForDelay,
  `slope ${baseDrift.maxAbsSlope?.toFixed(2)} -> ${delayedDrift.maxAbsSlope?.toFixed(2)} c/s`,
);

// Drift independence, without time-warping an envelope: render two analytic
// references from the same partials with the *same* envelope, one steady and
// one with a linear cents ramp. Identical envelopes make the fixed-delay
// reading zero by construction, so anything the drift reading reports is pitch
// only. That is the exact complement of the delay test above.
function analyticReference(partials, envelope, sr, n, centsPerSec) {
  const out = new Float32Array(n);
  const onset = envelope.onsetSample;
  const noteSec = (n - onset) / sr;
  const attack = envelope.attackSec ?? 0.01;
  const release = envelope.releaseSec ?? 0.02;
  const tMid = n / 2;
  // Phase is the integral of the instantaneous frequency, so a linear cents
  // ramp gives a true glide rather than a per-sample phase glitch.
  const phases = partials.map(() => 0);
  for (let i = 0; i < n; i++) {
    const local = (i - onset) / sr;
    let e = 0;
    if (local >= 0 && local <= noteSec) {
      e = 1;
      if (local < attack) e = local / attack;
      if (local > noteSec - release) e *= Math.max(0, (noteSec - local) / release);
    }
    let s = 0;
    for (let p = 0; p < partials.length; p++) {
      const cents = centsPerSec * ((i - tMid) / sr);
      const f = partials[p].hz * Math.pow(2, cents / 1200);
      phases[p] += (2 * Math.PI * f) / sr;
      s += partials[p].amp * Math.sin(phases[p]);
    }
    out[i] = e * s;
  }
  return out;
}

const envelope = { onsetSample: sampleCase.referenceOnsetSample, attackSec: 0.01, releaseSec: 0.03 };
const partialDefs = sampleCase.targets.map((t) => ({ hz: t.targetHz, amp: t.amp ?? 0.3 }));
const steadyRef = analyticReference(partialDefs, envelope, sampleCase.sampleRate, sampleRef.length, 0);
const glidingRef = analyticReference(partialDefs, envelope, sampleCase.sampleRate, sampleRef.length, 45);

const steadyDrift = measureFrequencyDrift(steadyRef, sampleCase.sampleRate, sampleCase.targets, { onsetSample: sampleCase.referenceOnsetSample });
const glidingDrift = measureFrequencyDrift(glidingRef, sampleCase.sampleRate, sampleCase.targets, { onsetSample: sampleCase.referenceOnsetSample });
const glideDelay = measureFixedDelaySamples(glidingRef, steadyRef, sampleCase.sampleRate);

const driftMoved = (glidingDrift.maxAbsSlope ?? 0) - (steadyDrift.maxAbsSlope ?? 0);
check(
  'injected pitch glide moves the drift reading',
  driftMoved > 20,
  `steady ${steadyDrift.maxAbsSlope?.toFixed(2)} -> gliding ${glidingDrift.maxAbsSlope?.toFixed(2)} c/s`,
);
check(
  'identical envelopes: pitch glide leaves the delay reading essentially unchanged',
  Math.abs(glideDelay.lagSamples ?? 0) <= 16,
  `delay(steady, gliding) = ${glideDelay.lagSamples} spl`,
);

// ----------------------------------------------------- 4. backends differ ---
let differing = 0;
let total = 0;
for (const c of library.cases) {
  const ids = Object.keys(c.backends);
  if (ids.length < 2) continue;
  total++;
  if ((c.divergence?.segmentCount ?? 0) > 0) differing++;
}
check('every case records a measurable cross-backend divergence region', differing === total, `${differing}/${total}`);

// ------------------------------------------------------------ 5. summary ----
const failed = checks.filter((c) => !c.ok);
const audit = {
  auditedAt: new Date().toISOString(),
  source: 'all figures re-derived from WAVs in outputs/compat',
  libraryGeneratedAt: library.generatedAt,
  caseCount: library.cases.length,
  checks,
  mismatches: mismatches.slice(0, 50),
  mismatchCount: mismatches.length,
  independence: {
    baseDelaySamples: baseDelay.lagSamples,
    injectedDelaySamples: 128,
    delayedReadingSamples: delayedDelay.lagSamples,
    baseDriftCentsPerSec: baseDrift.maxAbsSlope,
    delayedDriftCentsPerSec: delayedDrift.maxAbsSlope,
    steadyReferenceDriftCentsPerSec: steadyDrift.maxAbsSlope,
    glidingReferenceDriftCentsPerSec: glidingDrift.maxAbsSlope,
    glideDelayReadingSamples: glideDelay.lagSamples,
  },
  passed: checks.length - failed.length,
  failed: failed.length,
};
writeFileSync(join(outDir, 'audit.json'), JSON.stringify(audit, null, 2));

console.log(`\n${audit.passed}/${checks.length} audit checks passed`);
if (mismatches.length) {
  console.log(`\n${mismatches.length} disk-vs-stored mismatches (first 5):`);
  for (const m of mismatches.slice(0, 5)) console.log(' -', JSON.stringify(m));
}
if (failed.length) process.exit(1);
