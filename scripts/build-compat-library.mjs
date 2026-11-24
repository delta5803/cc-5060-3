#!/usr/bin/env node
// Builds the compatibility fixture library from the editable source-set JSON.
//
// For every scenario x rate variant it writes, into outputs/compat/:
//   inputs/<id>.wav          the editable ground truth, synthesised here
//   references/<id>_<st>st.wav  control regenerated from the original harmonics
// and records per-(window, rate) onset compensation plus per-backend
// measurements in compat/library.json.
//
// Nothing here is hand-authored audio: change fixtures/sources/*.json and rerun.

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandSourceSet,
  validateSourceSet,
  renderSource,
  renderReference,
  targetPartials,
} from '../src/dsp/sources.js';
import { encodeWav } from '../src/dsp/wav.js';
import { parseWav } from '../src/dsp/wav.js';
import { listBackends, processWithBackend } from '../src/dsp/backends.js';
import {
  firstEffectiveOnsetSample,
  measureFixedDelaySamples,
  measureFrequencyDrift,
  differenceSegments,
} from '../src/dsp/compat.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'fixtures', 'sources');
const outDir = join(root, 'outputs', 'compat');
const inDir = join(outDir, 'inputs');
const refDir = join(outDir, 'references');
const backendOutDir = join(outDir, 'outputs');
for (const d of [outDir, inDir, refDir, backendOutDir]) mkdirSync(d, { recursive: true });
for (const b of listBackends()) mkdirSync(join(backendOutDir, b.id), { recursive: true });

// Windows and rates the library probes. These are the "windows" a maintainer
// edits; the compensation table is keyed by (window, sampleRate).
const WINDOWS = [1024, 2048, 4096];
const TRANSPOSE_SEMITONES = [7, -5];
const TOLERANCES = {
  onsetSamples: 64,
  delayMs: 3.0,
  driftCentsPerSec: 5.0,
  driftCents: 25.0,
};

function writeWav(path, channel, sampleRate) {
  writeFileSync(path, encodeWav([channel], sampleRate, 16));
}

// Write the channel, then parse the bytes back. Everything measured is taken
// from this returned array, so the numbers of record are literally what the
// shipped file contains after 16-bit quantisation - not the float buffer that
// produced it. This is also what the audit tool independently re-reads.
function writeAndReadBack(path, channel, sampleRate) {
  const bytes = encodeWav([channel], sampleRate, 16);
  writeFileSync(path, bytes);
  const parsed = parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return parsed.channels[0];
}

function loadSourceSets() {
  return readdirSync(srcDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(srcDir, f), 'utf8')));
}

const sets = loadSourceSets();
const setIssues = [];
for (const set of sets) {
  const issues = validateSourceSet(set);
  if (issues.length) setIssues.push({ id: set.id, issues });
}
if (setIssues.length) {
  console.error('source-set validation failed:');
  for (const s of setIssues) console.error(' ', s.id, s.issues);
  process.exit(1);
}

const library = {
  generatedAt: new Date().toISOString(),
  schema: 'spectral-transposer/compat-library@1',
  note: 'Derived entirely from fixtures/sources/*.json. Regenerate with scripts/build-compat-library.mjs.',
  sampleRateVariants: [...new Set(sets.flatMap((s) => s.variants.map((v) => v.sampleRate)))].sort((a, b) => a - b),
  windows: WINDOWS,
  transposeSemitones: TRANSPOSE_SEMITONES,
  tolerances: TOLERANCES,
  backends: listBackends(),
  onsetCompensation: [],
  cases: [],
  sources: [],
};

for (const set of sets) {
  const variants = expandSourceSet(set);
  for (const def of variants) {
    const sr = def.sampleRate;
    const inputName = `${def.id}.wav`;
    // Measure the samples that actually ship: write, then parse back.
    const input = writeAndReadBack(join(inDir, inputName), renderSource(def), sr);

    for (const semis of TRANSPOSE_SEMITONES) {
      const ratio = Math.pow(2, semis / 12);
      const refName = `${def.id}_${semis >= 0 ? 'plus' : 'minus'}${Math.abs(semis)}st.wav`;
      const reference = writeAndReadBack(join(refDir, refName), renderReference(def, ratio), sr);

      const targets = targetPartials(def, ratio);
      const refOnset = firstEffectiveOnsetSample(reference, sr);

      for (const windowSize of WINDOWS) {
        const perBackend = {};
        const quantizedByBackend = {};
        for (const backend of listBackends()) {
          const res = processWithBackend(backend.id, input, sr, {
            semitones: semis,
            frameSize: windowSize,
            autoFrameSize: false,
          });
          const outName = `${def.id}_${semis >= 0 ? 'plus' : 'minus'}${Math.abs(semis)}st_w${windowSize}.wav`;
          const out = writeAndReadBack(join(backendOutDir, backend.id, outName), res.output, sr);
          quantizedByBackend[backend.id] = out;
          const outOnset = firstEffectiveOnsetSample(out, sr);
          const delay = measureFixedDelaySamples(out, reference, sr);
          const drift = measureFrequencyDrift(out, sr, targets, { onsetSample: def.onsetSample });
          const onsetShift = outOnset != null && refOnset != null ? outOnset - refOnset : null;
          perBackend[backend.id] = {
            outputSamples: out.length,
            durationPreserved: out.length === input.length,
            outputFile: join('outputs', backend.id, outName),
            referenceOnsetSample: refOnset,
            outputOnsetSample: outOnset,
            onsetShiftSamples: onsetShift,
            onsetShiftMs: onsetShift != null ? (onsetShift / sr) * 1000 : null,
            fixedDelay: {
              measuredSamples: delay.lagSamples,
              measuredMs: delay.lagMs,
              correlation: delay.correlation,
            },
            frequencyDrift: {
              maxAbsCents: drift.maxAbsCents,
              maxAbsSlope: drift.maxAbsSlope,
              partials: drift.partials.map((p) => ({
                targetHz: p.targetHz,
                meanCents: p.meanCents,
                slopeCentsPerSec: p.slopeCentsPerSec,
                rangeCents: p.rangeCents,
              })),
            },
          };
        }

        // Cross-backend divergence: where the two backends disagree, and which
        // input sample each disagreement peak maps back to. Uses the same
        // quantised samples that were written, so the regions describe the
        // files on disk.
        const primary = listBackends()[0].id;
        const secondary = listBackends()[1]?.id;
        let divergence = null;
        if (secondary) {
          const a = quantizedByBackend[primary];
          const b = quantizedByBackend[secondary];
          const segs = differenceSegments(a, b, input, {
            sampleRate: sr, threshold: 0.02, minMs: 20, envMs: 10,
          });
          divergence = {
            between: [primary, secondary],
            segmentCount: segs.count,
            segments: segs.segments.slice(0, 12),
            totalDifferingSamples: segs.totalDifferingSamples,
          };
        }

        // Onset compensation is the onset shift of the production backend: the
        // amount a caller must shift to line up with the reference, by window
        // and rate. Recorded even when it is small so the table is complete.
        const prod = perBackend[primary];
        library.onsetCompensation.push({
          scenario: set.scenario,
          sourceId: def.id,
          semitones: semis,
          windowSize,
          sampleRate: sr,
          onsetShiftSamples: prod.onsetShiftSamples,
          onsetShiftMs: prod.onsetShiftMs,
          refOnsetSample: prod.referenceOnsetSample,
          outOnsetSample: prod.outputOnsetSample,
        });

        library.cases.push({
          sourceId: def.id,
          scenario: set.scenario,
          sampleRate: sr,
          semitones: semis,
          windowSize,
          inputFile: join('inputs', inputName),
          referenceFile: join('references', refName),
          referenceOnsetSample: refOnset,
          targets,
          backends: perBackend,
          divergence,
        });
      }
    }

    library.sources.push({
      id: def.id,
      setId: def.setId,
      scenario: def.scenario,
      sampleRate: sr,
      durationSec: def.durationSec,
      onsetSample: def.onsetSample,
      inputFile: join('inputs', inputName),
      partials: def.partials,
      nearWindowEdge: def.nearWindowEdge === true,
    });
  }
}

writeFileSync(join(outDir, 'library.json'), JSON.stringify(library, null, 2));

// A compact, human-facing compensation table (Markdown) so a maintainer can
// read the per-window/rate onset offsets without opening the JSON.
const lines = [];
lines.push('# Onset compensation by window and sample rate', '');
lines.push('Shift applied to line the production backend up with the regenerated reference.');
lines.push('Positive = output onset is later than the reference. The window column is the');
lines.push('analysis frame size; each cell shows samples / ms. "—" means that rate was not');
lines.push('generated for that source.', '');
const rates = library.sampleRateVariants;
lines.push(`| scenario / source | st | window | ${rates.map((r) => `${r} Hz`).join(' | ')} |`);
lines.push(`| --- | --- | --- | ${rates.map(() => '---').join(' | ')} |`);
const scenKeys = [...new Set(library.onsetCompensation.map((c) => `${c.scenario}|${c.sourceId}|${c.semitones}|${c.windowSize}`))];
const fmtCell = (e) => (e && e.onsetShiftSamples != null
  ? `${e.onsetShiftSamples} / ${e.onsetShiftMs.toFixed(2)}`
  : '—');
for (const key of scenKeys) {
  const [scenario, sourceId, semis, windowSize] = key.split('|');
  const cells = rates.map((r) => fmtCell(library.onsetCompensation.find(
    (c) => c.scenario === scenario && c.sourceId === sourceId
      && String(c.semitones) === semis && String(c.windowSize) === windowSize && c.sampleRate === r,
  )));
  lines.push(`| ${scenario} · ${sourceId} | ${semis} | ${windowSize} | ${cells.join(' | ')} |`);
}
lines.push('', `Windows: ${library.windows.join(', ')}. Generated ${library.generatedAt}.`);
writeFileSync(join(outDir, 'onset-compensation.md'), lines.join('\n'));

console.log(`Wrote ${library.cases.length} compatibility cases and ${library.sources.length} sources.`);
console.log(`Outputs in ${outDir}`);
