// Test suite. Run with: node tests/run-tests.mjs

import {
  processAudio,
  analyzeAudio,

  semitonesToRatio,
  capabilities,
  LIMITS,
  KernelError,
} from '../src/dsp/transpose.js';
import { encodeWav, parseWav } from '../src/dsp/wav.js';
import {
  amplitudeAt,
  estimateFreq,
  sampleEvidence,
  rms,
  peak,
  onsetTimeSec,
  lastAboveTimeSec,
} from '../src/dsp/measure.js';
import {
  SR,
  sineTone,
  dualTone,
  pluckedTone,
  phraseWithAttacks,
  reattackTone,
  silence,
  concat,
} from './signals.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err });
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function assertClose(actual, expected, tol, message) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${message || 'value'}: got ${actual}, expected ${expected} +/- ${tol}`);
  }
}

function cents(measured, target) {
  return 1200 * Math.log2(measured / target);
}

console.log('\n== kernel contracts ==');

test('capabilities describe a duration-preserving, no-playback-rate kernel', () => {
  const cap = capabilities();
  assert(cap.durationPreserved === true, 'durationPreserved flag');
  assert(cap.playbackRateUsed === false, 'playbackRateUsed flag');
  assert(cap.ratio.continuous === true, 'ratio is continuous');
  assert(cap.ratio.min === 0.5 && cap.ratio.max === 2.0, 'ratio range');
});

test('invalid ratio is rejected with a kernel error code', () => {
  let err = null;
  try {
    processAudio(sineTone({ freq: 220, seconds: 0.05 }), SR, { semitones: 14 });
  } catch (e) {
    err = e;
  }
  assert(err instanceof KernelError, 'throws KernelError');
  assert(err.code === 'RATIO_OUT_OF_RANGE', `code was ${err && err.code}`);
});

test('invalid transient mode and threshold are rejected', () => {
  const sig = sineTone({ freq: 220, seconds: 0.05 });
  for (const opts of [{ transientMode: 'nope' }, { transientThreshold: 1.5 }]) {
    let err = null;
    try {
      processAudio(sig, SR, opts);
    } catch (e) {
      err = e;
    }
    assert(err instanceof KernelError, 'throws KernelError');
  }
});

test('empty input yields empty output without throwing', () => {
  const res = processAudio(new Float32Array(0), SR, { semitones: 5 });
  assert(res.output.length === 0, 'empty output');
  assert(res.meta.outputLength === 0, 'meta length');
});

console.log('\n== single tone: frequency and duration ==');

for (const semis of [-12, -7, -3.5, 0, 2.25, 5, 7, 12]) {
  test(`sine 220 Hz ${semis >= 0 ? '+' : ''}${semis} st`, () => {
    const sig = sineTone({ freq: 220, seconds: 0.9, amp: 0.5 });
    const res = processAudio(sig, SR, { semitones: semis });
    const target = 220 * semitonesToRatio(semis);
    const measured = estimateFreq(res.output, SR, target * 0.7, target * 1.4, 4000, 30000);
    const err = cents(measured, target);
    assert(Math.abs(err) < 3, `pitch error ${err.toFixed(2)} cents`);
    assert(res.output.length === sig.length, 'sample count preserved');
    const amp = amplitudeAt(res.output, target, SR, 4000, 30000);
    assertClose(amp, 0.5, 0.02, 'amplitude');
  });
}

test('continuous (non-integer-cent) ratio is honoured', () => {
  const sig = sineTone({ freq: 300, seconds: 0.7 });
  const semis = 1.37;
  const res = processAudio(sig, SR, { semitones: semis });
  const target = 300 * semitonesToRatio(semis);
  const measured = estimateFreq(res.output, SR, target * 0.8, target * 1.2, 4000, 24000);
  assert(Math.abs(cents(measured, target)) < 3, `error ${cents(measured, target).toFixed(2)} cents`);
  assertClose(res.meta.ratio, semitonesToRatio(semis), 1e-12, 'ratio');
});

console.log('\n== duration evidence from samples ==');

test('output sample count equals input for every case in range', () => {
  for (const semis of [-12, -5, 0, 3.5, 12]) {
    const sig = sineTone({ freq: 220, seconds: 0.37 });
    const res = processAudio(sig, SR, { semitones: semis });
    assert(res.output.length === sig.length, `${semis} st length`);
    assert(res.meta.durationPreserved === true, `${semis} st flag`);
  }
});

test('event positions stay fixed relative to the input timeline', () => {
  const sig = phraseWithAttacks({ freq: 196, seconds: 2.0 });
  const res = processAudio(sig, SR, { semitones: 7 });
  const ev = sampleEvidence(sig, res.output, SR);
  assert(ev.sampleCountPreserved, 'sample count');
  assert(Math.abs(ev.onsetShiftSec) < 0.006, `onset shift ${ev.onsetShiftSec}`);
  assert(Math.abs(ev.endShiftSec) < 0.02, `end shift ${ev.endShiftSec}`);
});

test('short fragments keep exact length', () => {
  for (const n of [1, 7, 64, 256, 1024, 2048, 4097]) {
    const sig = pluckedTone({ freq: 330, seconds: n / SR });
    const res = processAudio(sig, SR, { semitones: 4 });
    assert(res.output.length === n, `n=${n} produced ${res.output.length}`);
    assert(res.output.every(Number.isFinite), `n=${n} finite output`);
  }
});

test('leading and trailing silence are preserved', () => {
  const sig = concat([
    silence(0.08),
    pluckedTone({ freq: 262, seconds: 0.4 }),
    silence(0.25),
  ]);
  const res = processAudio(sig, SR, { semitones: -3 });
  assert(res.output.length === sig.length, 'length');
  assert(peak(res.output.subarray(0, Math.round(0.06 * SR))) < 1e-3, 'start silent');
  assert(peak(res.output.subarray(res.output.length - Math.round(0.2 * SR))) < 1e-3, 'end silent');
  assertClose(onsetTimeSec(res.output, SR), onsetTimeSec(sig, SR), 0.006, 'onset');
  assertClose(lastAboveTimeSec(res.output, SR), lastAboveTimeSec(sig, SR), 0.02, 'tail');
});

console.log('\n== two partials and phase locking ==');

test('dual tone: both partials land on target with amplitudes kept', () => {
  const sig = dualTone({ freqs: [440, 554.365], seconds: 1.1, amps: [0.32, 0.24] });
  for (const semis of [-5, 4, 9]) {
    const res = processAudio(sig, SR, { semitones: semis });
    const f1 = 440 * semitonesToRatio(semis);
    const f2 = 554.365 * semitonesToRatio(semis);
    assert(Math.abs(cents(estimateFreq(res.output, SR, f1 * 0.9, f1 * 1.1, 6000, 30000), f1)) < 5, `f1 ${semis}`);
    assert(Math.abs(cents(estimateFreq(res.output, SR, f2 * 0.9, f2 * 1.1, 6000, 30000), f2)) < 5, `f2 ${semis}`);
    assertClose(amplitudeAt(res.output, f1, SR, 6000, 30000), 0.32, 0.03, `amp1 ${semis}`);
    assertClose(amplitudeAt(res.output, f2, SR, 6000, 30000), 0.24, 0.03, `amp2 ${semis}`);
    assert(res.output.length === sig.length, 'length');
  }
});

test('phase locking suppresses intra-partial sidebands versus unlocked path', () => {
  const sig = dualTone({ freqs: [440, 554.365], seconds: 0.9, amps: [0.3, 0.22] });
  const semis = 5;
  const f1 = 440 * semitonesToRatio(semis);
  const f2 = 554.365 * semitonesToRatio(semis);

  const sidebandDb = (out, f) => {
    const main = amplitudeAt(out, f, SR, 10000, 30000) ** 2;
    const binHz = SR / 20000;
    let side = 0;
    for (const off of [-2, -1, 1, 2]) side += amplitudeAt(out, f + off * binHz, SR, 10000, 30000) ** 2;
    return 10 * Math.log10(main / Math.max(side, 1e-18));
  };
  const amDepth = (out) => {
    const w = Math.round(0.02 * SR);
    const vals = [];
    for (let i = 10000; i + w < 30000; i += w) vals.push(rms(out, i, i + w));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    return sd / mean;
  };

  const locked = processAudio(sig, SR, { semitones: semis, phaseLock: true });
  const unlocked = processAudio(sig, SR, { semitones: semis, phaseLock: false });
  const lockedSide = Math.min(sidebandDb(locked.output, f1), sidebandDb(locked.output, f2));
  const unlockedSide = Math.min(sidebandDb(unlocked.output, f1), sidebandDb(unlocked.output, f2));
  const lockedAm = amDepth(locked.output);
  const unlockedAm = amDepth(unlocked.output);
  console.log(
    `      locked sideband ${lockedSide.toFixed(1)} dB, AM ${(lockedAm * 100).toFixed(2)}%; ` +
      `unlocked ${unlockedSide.toFixed(1)} dB, AM ${(unlockedAm * 100).toFixed(2)}%`,
  );
  assert(lockedSide > unlockedSide + 12, 'locking improves sideband rejection by >12 dB');
  assert(lockedAm < unlockedAm, 'locking reduces amplitude modulation');
  assert(lockedAm < 0.02, 'locked AM depth below 2%');
});

test('peak-to-bin association is genuinely computed, phases are not shifted magnitudes', () => {
  const sig = dualTone({ freqs: [300, 620], seconds: 0.4 });
  const res = processAudio(sig, SR, { semitones: 5 });
  const frame = res.trace.frames.find((f) => f.partials.length >= 2 && f.partials[0].association.length > 0);
  assert(frame, 'trace frame with two partials');
  for (const p of frame.partials) {
    assert(p.association.length > 0, 'association bins present');
    let differing = 0;
    for (const b of p.association) {
      // usedPhase must equal targetPhase + offset (wrapped), and the offset
      // must come from the analysed bin phase, not from array translation.
      const expected = Math.atan2(
        Math.sin(p.targetPhase + b.phaseOffset),
        Math.cos(p.targetPhase + b.phaseOffset),
      );
      const diff = Math.atan2(
        Math.sin(b.usedPhase - expected),
        Math.cos(b.usedPhase - expected),
      );
      assert(Math.abs(diff) < 1e-3, 'usedPhase = target + offset');
      if (Math.abs(b.phaseOffset) > 1e-4) differing++;
    }
    assert(differing > 0, 'bins have distinct phase offsets (energy spread within lobe)');
  }
});

test('partial tracks keep identity across sustained frames', () => {
  const sig = dualTone({ freqs: [330, 495], seconds: 0.8 });
  const an = analyzeAudio(sig, SR);
  const sustained = an.tracks.filter((t) => t.lastTimeSec - t.firstTimeSec > 0.4);
  assert(sustained.length >= 2, `expected >=2 sustained tracks, got ${sustained.length}`);
  assert(sustained.every((t) => t.maxHz - t.minHz < 30), 'sustained tracks are stable');
});

console.log('\n== transients ==');

test('onset is detected and position preserved while pitch changes', () => {
  const sig = phraseWithAttacks({ freq: 196, seconds: 2.2 });
  for (const mode of ['auto', 'reset', 'continue']) {
    const res = processAudio(sig, SR, { semitones: 7, transientMode: mode });
    const ev = sampleEvidence(sig, res.output, SR);
    assert(ev.sampleCountPreserved, `${mode}: length`);
    assert(Math.abs(ev.onsetShiftSec) < 0.006, `${mode}: onset shift ${ev.onsetShiftSec}`);
    if (mode === 'auto' || mode === 'reset') {
      assert(res.meta.resetCount >= 1, `${mode}: resets applied`);
    } else {
      assert(res.meta.resetCount === 0, 'continue mode never resets');
    }
  }
});

test('phase reset at an onset changes the attack region relative to continue mode', () => {
  const sig = phraseWithAttacks({ freq: 196, seconds: 1.6 });
  const reset = processAudio(sig, SR, { semitones: 7, transientMode: 'reset' });
  const cont = processAudio(sig, SR, { semitones: 7, transientMode: 'continue' });
  let diff = 0;
  for (let i = 0; i < reset.output.length; i++) diff += Math.abs(reset.output[i] - cont.output[i]);
  diff /= reset.output.length;
  assert(diff > 1e-4, `reset and continue paths must differ (mean |diff| = ${diff})`);
});

test('sustained tone does not trigger spurious resets', () => {
  const sig = dualTone({ freqs: [440, 554.365], seconds: 1.2, amps: [0.3, 0.25] });
  const res = processAudio(sig, SR, { semitones: 5 });
  assert(res.meta.resetCount <= 1, `chord produced ${res.meta.resetCount} resets`);
  assert(res.meta.onsetEvents <= 2, `chord produced ${res.meta.onsetEvents} onset events`);
});

test('re-attack at the same pitch: reset, continue and always produce different phase behaviour', () => {
  const sig = reattackTone({ seconds: 1.4, freq: 220 });
  const outs = {};
  for (const mode of ['continue', 'reset', 'always']) {
    outs[mode] = processAudio(sig, SR, { semitones: 7, transientMode: mode });
    assert(outs[mode].output.length === sig.length, `${mode} length`);
  }
  assert(outs.continue.meta.resetCount === 0, 'continue never resets');
  assert(outs.reset.meta.resetCount >= 2, 'reset resets at the re-attack');
  assert(outs.always.meta.resetCount === outs.always.trace.frames.length, 'always resets every frame');

  const corr = (a, b, t0, lenSec = 0.05) => {
    const s = Math.round(t0 * SR);
    const e = s + Math.round(lenSec * SR);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = s; i < e; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / Math.sqrt(na * nb + 1e-18);
  };
  const rc = corr(outs.reset.output, outs.continue.output, 0.6);
  assert(rc < 0.9, `reset and continue must diverge at the re-attack (corr ${rc.toFixed(3)})`);

  const pitchSdAfter = (out, t0) => {
    const N = 4096;
    const tgt = 220 * semitonesToRatio(7);
    const s = Math.round(t0 * SR);
    const e = Math.min(out.length - N, s + Math.round(0.15 * SR));
    const freqs = [];
    for (let i = s; i + N <= e; i += N / 2) {
      freqs.push(estimateFreq(out.subarray(i, i + N), SR, tgt * 0.9, tgt * 1.1));
    }
    const mean = freqs.reduce((a, b) => a + b, 0) / freqs.length;
    return Math.sqrt(freqs.reduce((a, b) => a + (b - mean) ** 2, 0) / freqs.length);
  };
  const sdContinue = pitchSdAfter(outs.continue.output, 0.6);
  const sdAlways = pitchSdAfter(outs.always.output, 0.6);
  console.log(
    `      pitch SD after re-attack: continue ${sdContinue.toFixed(3)} Hz, always-reset ${sdAlways.toFixed(3)} Hz`,
  );
  assert(sdAlways > sdContinue * 1.3, 'resetting every frame scatters pitch more than continuing');
});

console.log('\n== dense material ==');

test('seven-partial chord: adaptive frame size separates all partials', () => {
  const freqs = [196, 246.94, 293.66, 349.23, 392, 440, 493.88];
  const sig = dualTone({ freqs, seconds: 1.2, amps: freqs.map(() => 0.045) });
  const res = processAudio(sig, SR, { semitones: 7 });
  assert(res.meta.autoFrameSize.applied === true, 'density adaptation applied');
  const ratio = semitonesToRatio(7);
  for (const f of freqs) {
    const amp = amplitudeAt(res.output, f * ratio, SR, 5000, 40000);
    assert(amp > 0.035, `partial ${f} kept amplitude, got ${amp.toFixed(4)}`);
  }
});

test('unresolvable close partials merge but total energy is retained (documented limit)', () => {
  // Two partials 8 Hz apart at 44100 Hz with a 2048 frame cannot be separated:
  // they fall in one main lobe and are treated as a single partial. The pair
  // merges into one beating component; energy is kept, per-partial identity
  // is not. This is the honest limit of the method.
  const sig = dualTone({ freqs: [440, 448], seconds: 0.9, amps: [0.3, 0.3] });
  const res = processAudio(sig, SR, { semitones: 5, autoFrameSize: false });
  const ratio = semitonesToRatio(5);
  const inRms = rms(sig, 6000, 30000);
  const outRms = rms(res.output, 6000, 30000);
  const a1 = amplitudeAt(res.output, 440 * ratio, SR, 6000, 30000);
  const a2 = amplitudeAt(res.output, 448 * ratio, SR, 6000, 30000);
  assert(res.meta.durationPreserved, 'length still preserved');
  assertClose(outRms, inRms, inRms * 0.25, 'total energy retained');
  assert(Math.max(a1, a2) < 0.25, 'the two partials are not reproduced separately');
  assert(Math.abs(a1 - a2) > 0.05, 'one merged component carries most of the energy');
});

console.log('\n== WAV round trip ==');

test('16-bit WAV encode/parse preserves sample count and coarse values', () => {
  const sig = sineTone({ freq: 440, seconds: 0.05 });
  const bytes = encodeWav([sig], SR, 16);
  const parsed = parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert(parsed.sampleRate === SR, 'sample rate');
  assert(parsed.channels.length === 1, 'channels');
  assert(parsed.channels[0].length === sig.length, 'sample count');
  let maxErr = 0;
  for (let i = 0; i < sig.length; i++) maxErr = Math.max(maxErr, Math.abs(parsed.channels[0][i] - sig[i]));
  assert(maxErr < 1 / 32000, `quantisation error ${maxErr}`);
});

test('exported transposed audio differs from input but matches length', () => {
  const sig = sineTone({ freq: 220, seconds: 0.5 });
  const res = processAudio(sig, SR, { semitones: 7 });
  const bytes = encodeWav([res.output], SR, 16);
  const parsed = parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert(parsed.channels[0].length === sig.length, 'exported length');
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff += Math.abs(parsed.channels[0][i] - sig[i]);
  assert(diff / sig.length > 0.01, 'output is genuinely different from input');
  const measured = estimateFreq(parsed.channels[0], SR, 300, 360, 4000, 18000);
  assert(Math.abs(cents(measured, 220 * semitonesToRatio(7))) < 5, 'exported pitch');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`\n--- ${f.name}\n${f.error.stack}`);
  }
  process.exit(1);
}
