#!/usr/bin/env node
// Drives the real interface in headless Chromium and checks what it renders.
// Requires playwright-core + a chromium install (see README).

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = process.env.BASE_URL || 'http://127.0.0.1:5173/';
const outDir = 'outputs/ui';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

await page.goto(base, { waitUntil: 'networkidle' });

check('page title', (await page.title()).includes('乐音移调'));

// Load the built-in phrase demo.
await page.click('#demo-phrase');
await page.waitForTimeout(500);

const trackName = await page.textContent('#track-name');
check('demo loads', trackName.includes('起音乐句'), trackName);

const shape = await page.evaluate(() => ({
  spectrum: [document.getElementById('spectrum').width, document.getElementById('spectrum').height],
  trace: [document.getElementById('trace').width, document.getElementById('trace').height],
}));
check('spectrum canvas sized', shape.spectrum[0] > 100 && shape.spectrum[1] > 100, JSON.stringify(shape.spectrum));

// Apply transposition at +7 semitones.
await page.fill('#semitones-num', '7');
await page.dispatchEvent('#semitones-num', 'change');
const ratioHint = await page.textContent('#ratio-hint');
check('ratio updates continuously', ratioHint.includes('1.4983'), ratioHint);

await page.click('#render');
await page.waitForTimeout(2500);

const evidence = await page.evaluate(() => {
  const out = {};
  document.querySelectorAll('#evidence dt').forEach((dt, i) => {
    const dd = document.querySelectorAll('#evidence dd')[i];
    out[dt.textContent] = { value: dd.textContent, cls: dd.className };
  });
  return out;
});
check('evidence has output samples', !!evidence['输出样本数'], JSON.stringify(evidence['输出样本数']));
check('sample counts match', /^(\d+)$/.test(evidence['输出样本数']?.value || ''), JSON.stringify(evidence['输出样本数']));
check('sample count preserved badge', evidence['样本数保持']?.value === '是', JSON.stringify(evidence['样本数保持']));
check('duration preserved', evidence['时长（输入/输出）']?.value.includes('2.400'), JSON.stringify(evidence['时长（输入/输出）']));
check('onset aligned', evidence['起音位置 输入/输出']?.cls === 'ok', JSON.stringify(evidence['起音位置 输入/输出']));

const badge = await page.textContent('#length-badge');
check('length badge shows both counts', /\d+ → \d+/.test(badge), badge);
const latency = await page.textContent('#latency-badge');
check('latency badge present', latency.includes('latency'), latency);

const dlEnabled = await page.evaluate(() => ({
  shifted: !document.getElementById('download-shifted').disabled,
  trace: !document.getElementById('download-trace').disabled,
}));
check('downloads enabled after render', dlEnabled.shifted && dlEnabled.trace, JSON.stringify(dlEnabled));

// Download the shifted WAV and verify it is a real, non-trivial WAV.
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#download-shifted'),
]);
const dlPath = `${outDir}/ui_shifted_7st.wav`;
await download.saveAs(dlPath);
const { readFileSync } = await import('node:fs');
const bytes = readFileSync(dlPath);
const isWav = bytes.slice(0, 4).toString() === 'RIFF' && bytes.slice(8, 12).toString() === 'WAVE';
check('downloaded WAV is RIFF/WAVE', isWav, `${bytes.length} bytes`);
const dataLen = bytes.readUInt32LE(40);
const sampleCount = dataLen / 2;
check('downloaded WAV sample count equals 2.4 s @ 44.1k', sampleCount === 105840, `${sampleCount}`);

// Screenshot the whole window in the rendered state.
await page.screenshot({ path: `${outDir}/window_after_render.png`, fullPage: false });

// Switch options and re-render: continue mode must report zero resets.
await page.selectOption('#mode', 'continue');
await page.click('#render');
await page.waitForTimeout(2500);
const resetRow = await page.evaluate(() => {
  const dts = [...document.querySelectorAll('#evidence dt')];
  const i = dts.findIndex((d) => d.textContent.includes('起音事件'));
  return document.querySelectorAll('#evidence dd')[i]?.textContent || '';
});
check('continue mode reports 0 resets', /\/\s*0$/.test(resetRow.trim()), resetRow);

// Failure feedback: force an out-of-range request by tampering with the kernel
// call through the UI's own path (number input clamps, so call the kernel via
// a direct evaluate to prove the feedback channel works).
const failureShown = await page.evaluate(async () => {
  const mod = await import('./src/dsp/transpose.js');
  try {
    mod.processAudio(new Float32Array(1000), 44100, { semitones: 30 });
    return { threw: false };
  } catch (e) {
    return { threw: true, code: e.code };
  }
});
check('kernel rejects out-of-range and exposes code', failureShown.threw && failureShown.code === 'RATIO_OUT_OF_RANGE', JSON.stringify(failureShown));

// Playback path: A and B must start buffers of equal length at rate 1.0.
// Instrument AudioBufferSourceNode before interaction so the test proves the
// transport never changes speed.
const page2 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page2.addInitScript(() => {
  window.__playback = [];
  const orig = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    window.__playback.push({
      rate: this.playbackRate.value,
      offset: args[1] || 0,
      length: this.buffer ? this.buffer.length : null,
      loop: this.loop,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
    });
    return orig.apply(this, args);
  };
});
await page2.goto(base, { waitUntil: 'networkidle' });
await page2.click('#demo-sine');
await page2.waitForTimeout(400);
await page2.click('#render');
await page2.waitForTimeout(1800);
await page2.click('#play-a');
await page2.waitForTimeout(150);
await page2.click('#play-b');
await page2.waitForTimeout(250);
const playback = await page2.evaluate(() => window.__playback);
check('A and B play at playbackRate 1.0', playback.length >= 2 && playback.every((r) => r.rate === 1), JSON.stringify(playback.map((r) => r.rate)));
check('A and B buffers have equal length', playback.length >= 2 && playback[0].length === playback[1].length, `${playback[0]?.length} vs ${playback[1]?.length}`);

// Segment loop: shift-click twice on the spectrum to mark a range, then loop it.
const box = await page2.locator('#spectrum').boundingBox();
await page2.click('#spectrum', { position: { x: Math.round(box.width * 0.25), y: 60 }, modifiers: ['Shift'] });
await page2.click('#spectrum', { position: { x: Math.round(box.width * 0.45), y: 60 }, modifiers: ['Shift'] });
const sel = await page2.textContent('#time');
check('shift-click marks an audition segment', /选段 \d+\.\d+–\d+\.\d+/.test(sel), sel);
const inspector = await page2.textContent('#frame-inspect');
check('frame inspector shows peak-to-bin association', /目标相位/.test(inspector) && /φin/.test(inspector), inspector.slice(0, 90));

await page2.click('#play-loop');
await page2.waitForTimeout(300);
const loopPlay = await page2.evaluate(() => window.__playback[window.__playback.length - 1]);
check('loop transport sets a real loop range', loopPlay.loop === true && loopPlay.loopEnd > loopPlay.loopStart, JSON.stringify({ loop: loopPlay.loop, s: loopPlay.loopStart.toFixed(3), e: loopPlay.loopEnd.toFixed(3) }));
check('loop transport keeps playbackRate 1.0', loopPlay.rate === 1, `${loopPlay.rate}`);
const loopTime = await page2.textContent('#time');
check('playhead wraps inside the loop window', (() => {
  const m = loopTime.match(/([\d.]+) \/ [\d.]+ s · 选段 ([\d.]+)–([\d.]+)/);
  if (!m) return false;
  const pos = +m[1];
  return pos >= +m[2] - 0.02 && pos <= +m[3] + 0.02;
})(), loopTime);
await page2.screenshot({ path: `${outDir}/window_loop_segment.png`, fullPage: false });
await page2.close();

// Re-render the dense demo and confirm adaptive frame announcement.
await page.click('#demo-dense');
await page.waitForTimeout(500);
await page.fill('#semitones-num', '7');
await page.dispatchEvent('#semitones-num', 'change');
await page.click('#render');
await page.waitForTimeout(3000);
const adaptiveRow = await page.evaluate(() => {
  const dts = [...document.querySelectorAll('#evidence dt')];
  const i = dts.findIndex((d) => d.textContent.includes('自适应帧长'));
  return document.querySelectorAll('#evidence dd')[i]?.textContent || '';
});
check('dense material triggers adaptive frame size', adaptiveRow.includes('已应用'), adaptiveRow);
await page.screenshot({ path: `${outDir}/window_dense.png`, fullPage: false });

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
if (failed.length) process.exit(1);
