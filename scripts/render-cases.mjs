#!/usr/bin/env node
// Offline renderer: generates test signals, transposes them, writes real WAV
// files plus machine-checkable evidence (sample counts, event positions,
// measured target frequencies).

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  processAudio,
  analyzeAudio,
  semitonesToRatio,
  capabilities,
  LIMITS,
} from '../src/dsp/transpose.js';
import { encodeWav } from '../src/dsp/wav.js';
import {
  SR,
  sineTone,
  dualTone,
  pluckedTone,
  phraseWithAttacks,
  reattackTone,
  silence,
  concat,
  rms,
  peak,
  estimateFreq,
  onsetTimeSec,
  lastAboveTimeSec,
  goertzelPower,
} from '../tests/signals.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'outputs');

function writeWav(name, channel, sampleRate = SR, bits = 16) {
  const bytes = encodeWav([channel], sampleRate, bits);
  const path = join(outDir, name);
  writeFileSync(path, bytes);
  return { file: name, path, bytes: bytes.length };
}

function amplitudeAt(sig, freq, sampleRate, from, to) {
  let a = 0;
  let b = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const t = (i - from) / sampleRate;
    a += sig[i] * Math.cos(2 * Math.PI * freq * t);
    b += sig[i] * Math.sin(2 * Math.PI * freq * t);
    n++;
  }
  return (2 * Math.hypot(a, b)) / n;
}

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, 'traces'), { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  kernel: capabilities(),
  sampleRate: SR,
  files: [],
  cases: [],
};

function addCase(entry) {
  report.cases.push(entry);
}

// ---------------------------------------------------------------- 1. sine ---

const sine = sineTone({ freq: 220, seconds: 1.6, amp: 0.5 });
const sineIn = writeWav('case1_sine220_input.wav', sine);
report.files.push({ role: 'input', ...sineIn, samples: sine.length, seconds: sine.length / SR });

for (const semis of [7, -5, 3.5, 12, -12]) {
  const r = processAudio(sine, SR, { semitones: semis });
  const target = 220 * semitonesToRatio(semis);
  const measured = estimateFreq(r.output, SR, 60, 1200);
  const name = `case1_sine220_${semis >= 0 ? 'plus' : 'minus'}${Math.abs(semis).toString().replace('.', 'p')}st.wav`;
  const w = writeWav(name, r.output);
  report.files.push({ role: 'output', semitones: semis, ...w, samples: r.output.length, seconds: r.output.length / SR });
  addCase({
    id: `sine220_${semis}st`,
    kind: 'single-sine',
    inputSeconds: sine.length / SR,
    outputSeconds: r.meta.outputLength / SR,
    semitones: semis,
    ratio: r.meta.ratio,
    targetHz: target,
    measuredHz: measured,
    frequencyErrorCents: 1200 * Math.log2(measured / target),
    amplitudeIn: amplitudeAt(sine, 220, SR, 4000, 30000),
    amplitudeOut: amplitudeAt(r.output, target, SR, 4000, 30000),
    durationPreserved: r.meta.durationPreserved,
    inputSamples: r.meta.inputLength,
    outputSamples: r.meta.outputLength,
    file: name,
  });
}

// ---------------------------------------------------------------- 2. dual ---

const dual = dualTone({ freqs: [440, 554.365], seconds: 1.4, amps: [0.32, 0.24] });
const dualIn = writeWav('case2_dual_input.wav', dual);
report.files.push({ role: 'input', ...dualIn, samples: dual.length, seconds: dual.length / SR });

for (const semis of [7, -5]) {
  const r = processAudio(dual, SR, { semitones: semis });
  const f1 = 440 * semitonesToRatio(semis);
  const f2 = 554.365 * semitonesToRatio(semis);
  const name = `case2_dual_${semis >= 0 ? 'plus' : 'minus'}${Math.abs(semis)}st.wav`;
  const w = writeWav(name, r.output);
  report.files.push({ role: 'output', semitones: semis, ...w, samples: r.output.length });
  addCase({
    id: `dual440_554_${semis}st`,
    kind: 'two-partial-chord',
    semitones: semis,
    ratio: r.meta.ratio,
    targets: [f1, f2],
    measured: [estimateFreq(r.output, SR, f1 * 0.9, f1 * 1.1), estimateFreq(r.output, SR, f2 * 0.9, f2 * 1.1)],
    amplitudesIn: [amplitudeAt(dual, 440, SR, 4000, 30000), amplitudeAt(dual, 554.365, SR, 4000, 30000)],
    amplitudesOut: [amplitudeAt(r.output, f1, SR, 4000, 30000), amplitudeAt(r.output, f2, SR, 4000, 30000)],
    durationPreserved: r.meta.durationPreserved,
    inputSamples: r.meta.inputLength,
    outputSamples: r.meta.outputLength,
    file: name,
  });
}

// -------------------------------------------------------------- 3. phrase ---

const phrase = phraseWithAttacks({ freq: 196, seconds: 2.4, amp: 0.5 });
const phraseIn = writeWav('case3_phrase_input.wav', phrase);
report.files.push({ role: 'input', ...phraseIn, samples: phrase.length, seconds: phrase.length / SR });

const phraseAnalysis = analyzeAudio(phrase, SR);

for (const semis of [7, -5, 12]) {
  for (const transientMode of ['auto', 'continue', 'reset']) {
    const r = processAudio(phrase, SR, { semitones: semis, transientMode });
    const name = `case3_phrase_${semis >= 0 ? 'plus' : 'minus'}${Math.abs(semis)}st_${transientMode}.wav`;
    const w = writeWav(name, r.output);
    report.files.push({
      role: 'output',
      semitones: semis,
      transientMode,
      ...w,
      samples: r.output.length,
    });
    const traceName = `case3_phrase_${semis >= 0 ? 'plus' : 'minus'}${Math.abs(semis)}st_${transientMode}.trace.json`;
    writeFileSync(join(outDir, 'traces', traceName), JSON.stringify(r.trace, null, 1));
    report.files.push({ role: 'trace', file: join('traces', traceName), samples: r.trace.frames.length, path: join(outDir, 'traces', traceName) });
    addCase({
      id: `phrase_${semis}st_${transientMode}`,
      kind: 'phrase-with-attacks',
      semitones: semis,
      transientMode,
      ratio: r.meta.ratio,
      targetFundamentalHz: 196 * semitonesToRatio(semis),
      measuredFundamentalHz: estimateFreq(r.output, SR, 150 * semitonesToRatio(semis) * 0.8, 350 * semitonesToRatio(semis) * 1.2),
      inputOnsetSec: onsetTimeSec(phrase, SR),
      outputOnsetSec: onsetTimeSec(r.output, SR),
      inputEndSec: lastAboveTimeSec(phrase, SR),
      outputEndSec: lastAboveTimeSec(r.output, SR),
      durationPreserved: r.meta.durationPreserved,
      inputSamples: r.meta.inputLength,
      outputSamples: r.meta.outputLength,
      onsetEvents: r.meta.onsetEvents,
      resetCount: r.meta.resetCount,
      resets: r.trace.resets,
      file: name,
    });
  }
}

// --------------------------------------------------------- 4. short & tail ---

const shortCase = [];
for (const ms of [2, 16, 64, 256]) {
  const n = Math.max(1, Math.round((ms / 1000) * SR));
  const sig = pluckedTone({ freq: 330, seconds: n / SR, amp: 0.5 });
  for (const semis of [4, -3]) {
    const r = processAudio(sig, SR, { semitones: semis });
    shortCase.push({
      ms,
      semitones: semis,
      inputSamples: sig.length,
      outputSamples: r.output.length,
      durationPreserved: r.meta.durationPreserved,
      peak: peak(r.output),
      finite: r.output.every(Number.isFinite),
    });
  }
}
addCase({ id: 'short_fragments', kind: 'short-and-tail', results: shortCase });

const tailInput = concat([silence(0.1), pluckedTone({ freq: 262, seconds: 0.5, amp: 0.5 }), silence(0.35)]);
const tailOut = processAudio(tailInput, SR, { semitones: -3 });
const tailName = 'case4_tail_padded_minus3st.wav';
writeWav(tailName, tailOut.output);
report.files.push({ role: 'output', semitones: -3, file: tailName, samples: tailOut.output.length });
addCase({
  id: 'tail_handling',
  kind: 'short-and-tail',
  inputSamples: tailInput.length,
  outputSamples: tailOut.meta.outputLength,
  durationPreserved: tailOut.meta.durationPreserved,
  inputOnsetSec: onsetTimeSec(tailInput, SR),
  outputOnsetSec: onsetTimeSec(tailOut.output, SR),
  inputEndSec: lastAboveTimeSec(tailInput, SR),
  outputEndSec: lastAboveTimeSec(tailOut.output, SR),
  edgeSilenceOutStart: peak(tailOut.output.subarray(0, Math.round(0.05 * SR))),
  edgeSilenceOutEnd: peak(tailOut.output.subarray(tailOut.output.length - Math.round(0.2 * SR))),
  file: tailName,
});

// --------------------------------------------- 4b. same-pitch re-attack ----

const reattack = reattackTone({ seconds: 1.4, freq: 220 });
const reattackIn = writeWav('case4b_reattack_input.wav', reattack);
report.files.push({ role: 'input', ...reattackIn, samples: reattack.length, seconds: reattack.length / SR });
const reattackCases = [];
for (const mode of ['auto', 'continue', 'reset', 'always']) {
  const r = processAudio(reattack, SR, { semitones: 7, transientMode: mode });
  const name = `case4b_reattack_plus7st_${mode}.wav`;
  writeWav(name, r.output);
  report.files.push({ role: 'output', semitones: 7, transientMode: mode, file: name, samples: r.output.length });
  const traceName = `case4b_reattack_plus7st_${mode}.trace.json`;
  writeFileSync(join(outDir, 'traces', traceName), JSON.stringify(r.trace, null, 1));
  report.files.push({ role: 'trace', file: join('traces', traceName), samples: r.trace.frames.length });
  reattackCases.push({
    mode,
    resets: r.meta.resetCount,
    onsetEvents: r.meta.onsetEvents,
    frames: r.meta.framesSynthesised,
    file: name,
    durationPreserved: r.meta.durationPreserved,
  });
}
addCase({ id: 'reattack_same_pitch', kind: 'same-pitch-reattack', results: reattackCases });

// ------------------------------------------------- 5. dense multi-partial ----

const chordFreqs = [196, 246.94, 293.66, 349.23, 392, 440, 493.88];
const dense = dualTone({ freqs: chordFreqs, seconds: 1.5, amps: chordFreqs.map(() => 0.045) });
const denseIn = writeWav('case5_dense_chord_input.wav', dense);
report.files.push({ role: 'input', ...denseIn, samples: dense.length });
for (const semis of [7, -5]) {
  const r = processAudio(dense, SR, { semitones: semis });
  const name = `case5_dense_${semis >= 0 ? 'plus' : 'minus'}${Math.abs(semis)}st.wav`;
  writeWav(name, r.output);
  report.files.push({ role: 'output', semitones: semis, file: name, samples: r.output.length });
  const measured = chordFreqs.map((f) => estimateFreq(r.output, SR, f * semitonesToRatio(semis) * 0.95, f * semitonesToRatio(semis) * 1.05));
  addCase({
    id: `dense_chord_${semis}st`,
    kind: 'dense-seven-partials',
    semitones: semis,
    ratio: r.meta.ratio,
    targets: chordFreqs.map((f) => f * semitonesToRatio(semis)),
    measured,
    errorsCents: measured.map((m, i) => 1200 * Math.log2(m / (chordFreqs[i] * semitonesToRatio(semis)))),
    inputAmps: chordFreqs.map((f) => amplitudeAt(dense, f, SR, 6000, 40000)),
    outputAmps: chordFreqs.map((f, i) => amplitudeAt(r.output, chordFreqs[i] * semitonesToRatio(semis), SR, 6000, 40000)),
    durationPreserved: r.meta.durationPreserved,
    inputSamples: r.meta.inputLength,
    outputSamples: r.meta.outputLength,
    file: name,
  });
}

// ------------------------------------------------------- 6. limit probes ----

const limits = [];
for (const semis of [12, 12.5, -12, -13]) {
  try {
    const r = processAudio(sineTone({ freq: 220, seconds: 0.2 }), SR, { semitones: semis });
    limits.push({ semitones: semis, ok: true, outputLength: r.meta.outputLength });
  } catch (err) {
    limits.push({ semitones: semis, ok: false, code: err.code, message: err.message, detail: err.detail });
  }
}
const highNote = [];
for (const semis of [12, 12.5]) {
  try {
    const hi = sineTone({ freq: 9000, seconds: 0.2, amp: 0.4 });
    const r = processAudio(hi, SR, { semitones: semis });
    highNote.push({
      semitones: semis,
      ok: true,
      note: 'content above Nyquist/ratio is band-limited rather than aliased',
      outputLength: r.meta.outputLength,
    });
  } catch (err) {
    highNote.push({ semitones: semis, ok: false, code: err.code, message: err.message });
  }
}
addCase({ id: 'range_and_alias', kind: 'limits', ratioRange: limits, highFrequency: highNote });

report.limitations = [
  'Transposition range is limited to +/-12 semitones (ratio 0.5..2.0). Beyond that, resampling band-limits too much content and quality degrades.',
  'Dense chords with partials closer than ~1.5 FFT bins share a region; the quieter partial can lose amplitude or inherit a neighbour phase. Measure per-partial error before relying on it for dense orchestral material.',
  'Percussive/transient material is handled by phase reset at detected onsets. Onsets that coincide within 40 ms are merged into one decision, so very fast repeated attacks (rolls, flams) may smear the second attack.',
  'Strongly inharmonic signals (bells, cymbals) have no stable peak identity; the tracker may re-identify partials and produce pitch drift.',
  'Upshifting by +12 st with broadband content leaves little headroom above the shifted Nyquist; the anti-alias filter removes it (correct, but audibly darker).',
  'Mono processing only in the browser build. Stereo/multichannel must be processed channel-by-channel with the same parameter set.',
];
report.shortFragmentResults = shortCase;

writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, 'phrase_analysis.json'), JSON.stringify(phraseAnalysis, null, 1));

console.log('Wrote', report.files.length, 'files to', outDir);
console.log('Cases:', report.cases.length);
const failed = report.cases.filter((c) => c.durationPreserved === false);
console.log('Duration failures:', failed.length);
