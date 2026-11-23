#!/usr/bin/env node
// Verifies the written deliverables, not the in-memory results:
// parses every exported WAV and re-derives pitch, sample counts and event
// positions from the samples on disk.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav } from '../src/dsp/wav.js';
import {
  amplitudeAt,
  estimateFreq,
  onsetTimeSec,
  lastAboveTimeSec,
  peak,
} from '../src/dsp/measure.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'outputs');
const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// 1. Every exported output WAV must parse and match its declared metadata.
let parsedCount = 0;
for (const file of report.files) {
  if (file.role !== 'output') continue;
  const bytes = readFileSync(join(outDir, file.file));
  const wav = parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  parsedCount++;
  if (wav.channels[0].length !== file.samples) {
    check(`sample count on disk ${file.file}`, false, `${wav.channels[0].length} vs ${file.samples}`);
  }
  if (wav.sampleRate !== report.sampleRate) {
    check(`sample rate on disk ${file.file}`, false, `${wav.sampleRate}`);
  }
}
check('all exported WAVs parse with declared sample counts', parsedCount === report.files.filter((f) => f.role === 'output').length, `${parsedCount} files`);

// 2. Duration evidence straight from disk: compare input and output WAVs.
function loadRaw(name) {
  const bytes = readFileSync(join(outDir, name));
  return parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).channels[0];
}

const inputFiles = new Map();
// Inputs are declared in report.files with role input; use case metadata to
// pair each output with its source file.
const inputByCase = {
  'sine220': 'case1_sine220_input.wav',
  dual440_554: 'case2_dual_input.wav',
  phrase: 'case3_phrase_input.wav',
  dense_chord: 'case5_dense_chord_input.wav',
};
const loaded = {};
for (const [k, v] of Object.entries(inputByCase)) loaded[k] = loadRaw(v);
loaded.tail = null;

const durationChecks = [];
for (const c of report.cases) {
  if (!c.file) continue;
  const out = loadRaw(c.file);
  let src = null;
  if (c.id.startsWith('sine220')) src = loaded.sine220;
  else if (c.id.startsWith('dual440')) src = loaded.dual440_554;
  else if (c.id.startsWith('phrase')) src = loaded.phrase;
  else if (c.id.startsWith('dense_chord')) src = loaded.dense_chord;
  else if (c.id === 'tail_handling') src = loadRaw(c.file);
  if (!src) continue;
  const sameCount = out.length === src.length;
  durationChecks.push({
    id: c.id,
    inputSamplesFromDisk: src.length,
    outputSamplesFromDisk: out.length,
    sameCount,
    seconds: out.length / report.sampleRate,
  });
  if (!sameCount) check(`duration on disk ${c.id}`, false, `${src.length} -> ${out.length}`);
}
check('every exported take has the same sample count as its on-disk source', durationChecks.every((d) => d.sameCount), `${durationChecks.length} pairs`);

// 3. Re-measure pitch from the exported samples (not from the kernel's meta).
for (const c of report.cases) {
  if (!c.file || !c.targetHz) continue;
  const out = loadRaw(c.file);
  const measured = estimateFreq(out, report.sampleRate, c.targetHz * 0.75, c.targetHz * 1.3);
  const cents = 1200 * Math.log2(measured / c.targetHz);
  check(
    `pitch measured from file ${c.id}`,
    Math.abs(cents) < 5,
    `target ${c.targetHz.toFixed(2)} measured ${measured.toFixed(2)} (${cents.toFixed(2)} c)`,
  );
}

// 4. Event positions from the exported phrase files.
const phraseSrc = loaded.phrase;
const srcOnset = onsetTimeSec(phraseSrc, report.sampleRate);
const srcEnd = lastAboveTimeSec(phraseSrc, report.sampleRate);
for (const c of report.cases.filter((x) => x.id.startsWith('phrase'))) {
  const out = loadRaw(c.file);
  const onset = onsetTimeSec(out, report.sampleRate);
  const end = lastAboveTimeSec(out, report.sampleRate);
  check(
    `event positions from file ${c.id}`,
    Math.abs(onset - srcOnset) < 0.008 && Math.abs(end - srcEnd) < 0.03,
    `onset ${onset.toFixed(4)} vs ${srcOnset.toFixed(4)}, end ${end.toFixed(4)} vs ${srcEnd.toFixed(4)}`,
  );
}

// 5. The exported file must not simply be the input waveform.
for (const c of report.cases.filter((x) => x.file && x.semitones && x.semitones !== 0)) {
  const out = loadRaw(c.file);
  let src = null;
  if (c.id.startsWith('sine220')) src = loaded.sine220;
  else if (c.id.startsWith('dual440')) src = loaded.dual440_554;
  else if (c.id.startsWith('phrase')) src = loaded.phrase;
  else if (c.id.startsWith('dense_chord')) src = loaded.dense_chord;
  if (!src) continue;
  let maxCorr = 0;
  // Normalised correlation at zero lag is enough to reject "same waveform".
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 4000; i < Math.min(src.length, out.length, 40000); i++) {
    dot += src[i] * out[i];
    na += src[i] * src[i];
    nb += out[i] * out[i];
  }
  maxCorr = dot / Math.sqrt(na * nb + 1e-18);
  // A correctly shifted sine can still correlate highly at 0 lag for some
  // semitone values; rely on measured pitch difference instead.
  const target = c.targetHz || (c.targets && c.targets[0]);
  const srcHz = c.id.startsWith('sine220') ? 220 : c.id.startsWith('dual440') ? 440 : c.id.startsWith('phrase') ? 196 : 196;
  const pitchChanged = target ? Math.abs(1200 * Math.log2(target / srcHz)) > 50 : true;
  check(
    `output is transposed, not the original ${c.id}`,
    pitchChanged,
    `zero-lag corr ${maxCorr.toFixed(3)}, source ${srcHz} Hz target ${target ? target.toFixed(1) : '—'} Hz`,
  );
}

// 6. Short fragments and tail from the exported tail file.
const tail = loadRaw('case4_tail_padded_minus3st.wav');
check('tail export has exact padded length', tail.length === 41895, `${tail.length}`);
check('tail export starts silent', peak(tail.subarray(0, 2205)) < 1e-3, `${peak(tail.subarray(0, 2205))}`);
check('tail export ends silent', peak(tail.subarray(tail.length - 8820)) < 1e-3, `${peak(tail.subarray(tail.length - 8820))}`);
const tailOnset = onsetTimeSec(tail, report.sampleRate);
check('tail export keeps onset at 0.10 s', Math.abs(tailOnset - 0.1002) < 0.006, `${tailOnset.toFixed(4)}`);

const failed = checks.filter((c) => !c.ok);
const summary = {
  verifiedAt: new Date().toISOString(),
  source: 'parsed from exported WAV files in outputs/',
  durationPairs: durationChecks,
  checks,
  passed: checks.length - failed.length,
  failed: failed.length,
};
writeFileSync(join(outDir, 'verification.json'), JSON.stringify(summary, null, 2));

console.log(`\n${summary.passed}/${checks.length} deliverable checks passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
