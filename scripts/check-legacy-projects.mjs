#!/usr/bin/env node
// Legacy-project compatibility check.
//
// Reads the old preset snapshot and old project list (fixtures/legacy/*.json),
// then for each project:
//   1. resolves the preset it references (tolerant of historical key names);
//   2. renders the project's played window from its sample offset, with no
//      history (the "cold" render a mid-stream seek produces);
//   3. renders the same window again with real pre-roll prepended (the "warm"
//      render), dropping the pre-roll from the output so both align to the
//      same source position;
//   4. lines the first effective onset up against the project's time marker;
//   5. classifies the result, keeping "preset could not be read" strictly
//      separate from "first window lacked history".
//
// Writes outputs/compat/legacy-projects.json and prints a table.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLegacyPresets,
  readLegacyProjects,
  classifyProjectCompatibility,
  firstEffectiveOnsetSample,
  measureFixedDelaySamples,
  measureFrequencyDrift,
} from '../src/dsp/compat.js';
import { renderSource, renderReference, targetPartials } from '../src/dsp/sources.js';
import { processWithBackend } from '../src/dsp/backends.js';
import { encodeWav } from '../src/dsp/wav.js';
import { rms } from '../src/dsp/measure.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const legacyDir = join(root, 'fixtures', 'legacy');
const singlesDir = join(root, 'fixtures', 'singles');
const outDir = join(root, 'outputs', 'compat', 'legacy');
mkdirSync(outDir, { recursive: true });

const tolerances = {
  onsetSamples: 64,
  delayMs: 3.0,
  driftCentsPerSec: 5.0,
  driftCents: 25.0,
};

const presetDoc = JSON.parse(readFileSync(join(legacyDir, 'presets.json'), 'utf8'));
const projectDoc = JSON.parse(readFileSync(join(legacyDir, 'projects.json'), 'utf8'));
const presetRead = readLegacyPresets(presetDoc);
const projectRead = readLegacyProjects(projectDoc);

const sourceCache = new Map();
function loadSource(sourceId) {
  if (!sourceCache.has(sourceId)) {
    const def = JSON.parse(readFileSync(join(singlesDir, `${sourceId}.json`), 'utf8'));
    sourceCache.set(sourceId, { def, signal: renderSource(def) });
  }
  return sourceCache.get(sourceId);
}

const presetById = new Map(presetRead.presets.map((p) => [p.id, p]));
const results = [];

for (const project of projectRead.projects) {
  const preset = presetById.get(project.presetId) || null;
  const presetReadable = !!(preset && preset.readable);

  const record = {
    id: project.id,
    name: project.name,
    sourceId: project.sourceId,
    presetId: project.presetId,
    preset: preset
      ? {
          id: preset.id,
          readable: preset.readable,
          frameSize: preset.frameSize,
          overlap: preset.overlap,
          phaseLock: preset.phaseLock,
          transientMode: preset.transientMode,
          sourceKeys: preset.sourceKeys,
          issues: preset.issues,
        }
      : null,
    sampleRate: project.sampleRate,
    playFromSample: project.playFromSample,
    markerSample: project.markerSample,
    markerSec: project.markerSec,
    transposeSemitones: project.transposeSemitones,
  };

  if (!presetReadable) {
    record.classification = classifyProjectCompatibility({
      presetReadable: false,
      presetIssues: preset ? preset.issues : ['preset id not found in snapshot'],
    });
    results.push(record);
    continue;
  }

  const { def, signal } = loadSource(project.sourceId);
  const sr = project.sampleRate;
  const semis = project.transposeSemitones ?? 0;
  const ratio = Math.pow(2, semis / 12);
  const windowSize = preset.frameSize;
  const opts = {
    semitones: semis,
    frameSize: windowSize,
    autoFrameSize: preset.autoFrameSize === undefined ? false : !!preset.autoFrameSize,
    transientMode: preset.transientMode || 'auto',
    transientThreshold: preset.transientThreshold ?? 0.5,
    phaseLock: preset.phaseLock !== false,
  };

  const playFrom = Math.max(0, Math.min(signal.length, project.playFromSample));
  const coldInput = signal.subarray(playFrom);
  const coldOut = processWithBackend('peak-locked', coldInput, sr, opts).output;

  // Warm render: prepend up to one full window of real history and drop the
  // pre-roll from the output so it maps to the same source position.
  const preRoll = Math.min(playFrom, windowSize);
  const warmFrom = playFrom - preRoll;
  const warmInput = signal.subarray(warmFrom);
  const warmFull = processWithBackend('peak-locked', warmInput, sr, opts).output;
  const warmOut = warmFull.subarray(preRoll);

  const markerLocalCold = project.markerSample - playFrom; // marker in cold-slice coords
  // warmOut has the pre-roll dropped, so index 0 also maps to `playFrom`.
  const markerLocalWarm = project.markerSample - playFrom;
  const searchRadius = Math.max(windowSize, Math.round(0.08 * sr));

  function onsetNear(sig, center, radius) {
    const lo = Math.max(0, center - radius);
    const hi = Math.min(sig.length, center + radius);
    if (hi - lo < 16) return null;
    const on = firstEffectiveOnsetSample(sig.subarray(lo, hi), sr);
    return on === null ? null : lo + on;
  }

  const coldOnsetLocal = onsetNear(coldOut, markerLocalCold, searchRadius);
  const warmOnsetLocal = onsetNear(warmOut, markerLocalWarm, searchRadius);

  const coldOnsetSource = coldOnsetLocal !== null ? playFrom + coldOnsetLocal : null;
  const warmOnsetSource = warmOnsetLocal !== null ? playFrom + warmOnsetLocal : null;

  // Cold-vs-warm difference in the first window: direct evidence that the
  // first analysis window lacks the samples that the warm render had.
  const firstWin = Math.min(windowSize, coldOut.length, warmOut.length);
  let sq = 0;
  for (let i = 0; i < firstWin; i++) {
    const d = coldOut[i] - warmOut[i];
    sq += d * d;
  }
  const coldFirstWindowRmsDiff = Math.sqrt(sq / Math.max(1, firstWin));

  // Delay / drift on the warm render (real history present). Both warmOut and
  // the reference are sliced from `playFrom`, so index 0 means the same source
  // position in each. Drift is only meaningful over sustained material; this is
  // a short decaying phrase, so a null drift is reported when there are too few
  // steady windows rather than a number that would be noise.
  const reference = renderReference(def, ratio);
  const referenceWindow = reference.subarray(playFrom);
  const targets = targetPartials(def, ratio);
  const delay = measureFixedDelaySamples(warmOut, referenceWindow, sr);
  // Drift is only trustworthy over material of stable pitch that spans several
  // windows. This phrase changes content at the marker, so restrict the drift
  // window to the steady region *before* the marker. If that region is too
  // short, report null rather than a number that would be noise.
  const markerLocal = project.markerSample - playFrom;
  const steadyEndSec = Math.max(0, (markerLocal - Math.round(0.03 * sr)) / sr);
  const drift = measureFrequencyDrift(warmOut, sr, targets, {
    onsetSample: 0,
    windowSamples: windowSize,
    hopSamples: Math.max(1, windowSize >> 2),
    skipStartSec: 0.02,
    skipEndSec: Math.max(0.02, warmOut.length / sr - steadyEndSec),
  });
  const driftUsable = drift.windows >= 3 && drift.maxAbsSlope !== null;

  record.cold = {
    playFromSample: playFrom,
    onsetSample: coldOnsetSource,
    onsetLocalSample: coldOnsetLocal,
    errorToMarkerSamples: coldOnsetSource !== null ? coldOnsetSource - project.markerSample : null,
    firstWindowRmsDiffVsWarm: coldFirstWindowRmsDiff,
    firstWindowSamples: firstWin,
  };
  record.warm = {
    preRollSamples: preRoll,
    onsetSample: warmOnsetSource,
    onsetLocalSample: warmOnsetLocal,
    errorToMarkerSamples: warmOnsetSource !== null ? warmOnsetSource - project.markerSample : null,
  };
  record.measurements = {
    fixedDelayMs: delay.lagMs,
    fixedDelaySamples: delay.lagSamples,
    fixedDelayCorrelation: delay.correlation,
    driftCentsPerSec: driftUsable ? drift.maxAbsSlope : null,
    driftCents: driftUsable ? drift.maxAbsCents : null,
    driftWindows: drift.windows,
    driftUsable,
    driftNote: driftUsable
      ? 'Measured over sustained windows after the marker.'
      : 'Too few steady windows for a trustworthy drift figure on this short decaying phrase; not reported.',
    driftPartials: drift.partials,
  };

  record.classification = classifyProjectCompatibility({
    presetReadable: true,
    presetIssues: [],
    playFromSample: playFrom,
    hasPreRoll: false, // this run models the old project's cold seek
    markerSample: project.markerSample,
    coldOnsetSample: coldOnsetSource,
    warmOnsetSample: warmOnsetSource,
    coldFirstWindowRmsDiff,
    firstWindowSamples: firstWin,
    delayMs: delay.lagMs,
    driftCentsPerSec: driftUsable ? drift.maxAbsSlope : undefined,
    tolerances,
  });

  // Write the cold and warm exports so the claim can be heard.
  writeFileSync(
    join(outDir, `${project.id}_cold.wav`),
    encodeWav([coldOut], sr, 16),
  );
  writeFileSync(
    join(outDir, `${project.id}_warm.wav`),
    encodeWav([warmOut], sr, 16),
  );

  results.push(record);
}

const payload = {
  generatedAt: new Date().toISOString(),
  schema: 'spectral-transposer/legacy-project-report@1',
  tolerances,
  presetReadIssues: presetRead.issues,
  presets: presetRead.presets.map((p) => ({
    id: p.id,
    readable: p.readable,
    frameSize: p.frameSize,
    issues: p.issues,
  })),
  results,
};
writeFileSync(join(outDir, '..', 'legacy-projects.json'), JSON.stringify(payload, null, 2));

console.log('Legacy project compatibility');
console.log('project              preset         status                          cold err  warm err');
for (const r of results) {
  const cold = r.cold ? `${r.cold.errorToMarkerSamples ?? '—'} spl` : '—';
  const warm = r.warm ? `${r.warm.errorToMarkerSamples ?? '—'} spl` : '—';
  console.log(
    `${String(r.id).padEnd(20)} ${String(r.presetId).padEnd(14)} ${String(r.classification.status).padEnd(31)} ${String(cold).padStart(8)}  ${String(warm).padStart(8)}`,
  );
}
console.log(`\nPreset read issues: ${presetRead.issues.length ? presetRead.issues.map((i) => i.id + ': ' + i.reason).join('; ') : 'none'}`);
console.log(`Wrote outputs/compat/legacy-projects.json and ${results.length * 2} WAVs in outputs/compat/legacy/`);
