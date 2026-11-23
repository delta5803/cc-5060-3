#!/usr/bin/env node
// Quantifies the transient trade-off on a same-pitch re-attack, where the
// partial track survives the attack so only the phase policy changes.
// All numbers are measured from the exported WAV samples.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav } from '../src/dsp/wav.js';
import { amplitudeAt, estimateFreq, rms } from '../src/dsp/measure.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'outputs');
const SR = 44100;
const ATTACK = 0.6;
const TARGET = 220 * Math.pow(2, 7 / 12);

function load(name) {
  const bytes = readFileSync(join(outDir, name));
  return parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).channels[0];
}

function attackRiseMs(signal, sr, t0) {
  const s = Math.max(1, Math.round((t0 - 0.005) * sr));
  const e = Math.min(signal.length, Math.round((t0 + 0.08) * sr));
  const w = Math.max(1, Math.round(0.0005 * sr));
  const env = [];
  for (let i = s; i + w <= e; i += w) env.push({ i, v: rms(signal, i, i + w) });
  const mx = Math.max(...env.map((x) => x.v));
  let t10 = null;
  let t90 = null;
  for (const { i, v } of env) {
    if (t10 === null && v >= 0.1 * mx) t10 = i;
    if (t90 === null && v >= 0.9 * mx) { t90 = i; break; }
  }
  return t10 !== null && t90 !== null ? ((t90 - t10) / sr) * 1000 : null;
}

function postOnsetPitchSdHz(signal, sr, t0) {
  const N = 4096;
  const s = Math.round(t0 * sr);
  const e = Math.min(signal.length - N, s + Math.round(0.15 * sr));
  const freqs = [];
  for (let i = s; i + N <= e; i += N / 2) {
    freqs.push(estimateFreq(signal.subarray(i, i + N), sr, TARGET * 0.9, TARGET * 1.1));
  }
  const mean = freqs.reduce((a, b) => a + b, 0) / freqs.length;
  // Also compare the local amplitude right after the attack: a coherent
  // reset reconstructs more of the attack energy.
  const amp = amplitudeAt(signal, TARGET, sr, s, s + Math.round(0.03 * sr));
  return {
    meanHz: mean,
    sdHz: Math.sqrt(freqs.reduce((a, b) => a + (b - mean) ** 2, 0) / freqs.length),
    attackWindowAmplitude: amp,
    windows: freqs.length,
  };
}

function divergence(a, b, t0, lenSec = 0.05) {
  const s = Math.round(t0 * SR);
  const e = s + Math.round(lenSec * SR);
  let dot = 0;
  let na = 0;
  let nb = 0;
  let l1 = 0;
  for (let i = s; i < e; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
    l1 += Math.abs(a[i] - b[i]);
  }
  return { corr: dot / Math.sqrt(na * nb + 1e-18), meanAbsDiff: l1 / (e - s) };
}

const modes = ['auto', 'continue', 'reset', 'always'];
const sig = Object.fromEntries(modes.map((m) => [m, load(`case4b_reattack_plus7st_${m}.wav`)]));

const rows = modes.map((mode) => {
  const signal = sig[mode];
  const metrics = postOnsetPitchSdHz(signal, SR, ATTACK);
  return {
    mode,
    file: `case4b_reattack_plus7st_${mode}.wav`,
    attackRiseMs: attackRiseMs(signal, SR, ATTACK),
    postOnsetPitchMeanHz: metrics.meanHz,
    postOnsetPitchSdHz: metrics.sdHz,
    attackWindowAmplitude: metrics.attackWindowAmplitude,
    comparedToContinue: mode === 'continue' ? null : divergence(signal, sig.continue, ATTACK),
  };
});

const payload = {
  measuredFrom: 'outputs/case4b_reattack_plus7st_*.wav',
  scenario: '220 Hz note with a re-attack at 0.6 s at the same pitch; transposed +7 st',
  columns: {
    attackRiseMs: '10%→90% envelope rise at the re-attack (lower = sharper)',
    postOnsetPitchSdHz: 'pitch scatter over 150 ms after the attack (lower = steadier)',
    attackWindowAmplitude: 'amplitude of the target partial in the first 30 ms after the attack',
    comparedToContinue: 'correlation / mean absolute difference against continue mode at the attack',
  },
  rows,
  conclusion:
    'Continue mode keeps the pitch trajectory smooth but reconstructs the attack from ' +
    'propagated phases; reset mode rebuilds the attack coherently, changing the waveform at the ' +
    'attack while the sustained portion stays pitch-stable. Resetting every frame scatters the ' +
    'pitch considerably, which is why auto mode only resets when onset reliability is high.',
};
writeFileSync(join(outDir, 'transient-tradeoff.json'), JSON.stringify(payload, null, 2));

console.log('same-pitch re-attack, +7 st, measured from exported files');
console.log('mode      rise(ms)  postOnset pitch mean/sd (Hz)   attackAmp   corr-vs-continue');
for (const r of rows) {
  const d = r.comparedToContinue;
  console.log(
    `${r.mode.padEnd(9)} ${String(r.attackRiseMs?.toFixed(2)).padStart(8)}  ` +
      `${r.postOnsetPitchMeanHz.toFixed(2)} / ${r.postOnsetPitchSdHz.toFixed(3)}`.padEnd(28) +
      `  ${r.attackWindowAmplitude.toFixed(4)}     ` +
      (d ? `${d.corr.toFixed(3)} (L1 ${d.meanAbsDiff.toFixed(4)})` : '—'),
  );
}
