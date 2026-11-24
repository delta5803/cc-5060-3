#!/usr/bin/env node
// Logic-level UI check. Runs the page's real module script under a small DOM
// stub (tests/dom-stub.mjs) so the wiring — backend selection, cross-backend
// compare, difference-segment return-to-input, legacy panel — is exercised even
// when no browser binary is installed. This proves wiring and computation, not
// visuals; the Chromium test (tests/ui-check.mjs) covers rendering.

import { writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDom, extractModuleScript } from './dom-stub.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { elements } = installDom({ root });
const script = extractModuleScript(root);

// The page's imports are relative to its own directory; placing the extracted
// module at the project root makes them resolve exactly as in the browser.
const generated = join(root, '.ui-under-test.mjs');
writeFileSync(generated, script + '\n//# sourceURL=ui-under-test.mjs\n');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await import(pathToFileURL(generated).href);
  await sleep(150); // loadLegacyPanel fetch

  // --- backend selector is populated from the registry, not hard-coded ----
  const backend = elements.get('backend');
  const optValues = backend.children.map((c) => c.value);
  check(
    'backend selector is populated from the registry',
    optValues.includes('peak-locked') && optValues.includes('plain-vocoder'),
    JSON.stringify(optValues),
  );

  // --- legacy panel distinguishes the two failure kinds ------------------
  const legacyPresets = elements.get('legacy-presets').innerHTML;
  const legacyProjects = elements.get('legacy-projects').innerHTML;
  check('legacy panel lists readable presets', /可读/.test(legacyPresets), legacyPresets.slice(0, 60));
  check(
    'legacy panel shows preset-read-failed',
    /预设读取失败/.test(legacyProjects),
    (legacyProjects.match(/预设读取失败/) || [''])[0],
  );
  check(
    'legacy panel shows first-window-missing-history',
    /首窗缺少历史样本/.test(legacyProjects),
    (legacyProjects.match(/首窗缺少历史样本/) || [''])[0],
  );

  // --- load a demo and render with the production backend ----------------
  elements.get('demo-phrase').trigger('click');
  await sleep(600);
  check('demo loads', /起音乐句/.test(elements.get('track-name').textContent));

  elements.get('semitones-num').value = '7';
  elements.get('semitones-num').trigger('change', { target: { value: '7' } });
  elements.get('render').trigger('click');
  await sleep(2500);
  const evidence = elements.get('evidence').innerHTML;
  check('render produces evidence rows', /输出样本数/.test(evidence), evidence.slice(0, 40));
  check('render reports sample count preserved', /样本数保持<\/dt><dd class="ok">是/.test(evidence));

  // --- compare both backends and locate divergence segments --------------
  elements.get('compare-backends').trigger('click');
  await sleep(200);
  const summary = elements.get('compat-summary').innerHTML;
  const segList = elements.get('compat-segments');
  check('compare summary names both backends', /峰锁定/.test(summary) && /逐箱/.test(summary), summary.slice(0, 80));
  check('compare summary reports affected preset params', /帧 · /.test(summary), summary.replace(/<[^>]*>/g, ' ').slice(0, 120));
  check('compare lists divergence segments', segList.children.length > 0, `${segList.children.length} rows`);

  // Click the first segment: playhead jumps to its peak and the input sample
  // the difference peak maps to is shown.
  const firstRow = segList.children[0];
  firstRow.trigger('click');
  await sleep(50);
  const toastText = elements.get('toast').textContent;
  check('segment click reports the input sample it maps to', /输入采样 #\d+/.test(toastText), toastText);
  check('segment click moves the playhead', /^[\d.]+ \/ [\d.]+ s/.test(elements.get('time').textContent), elements.get('time').textContent);
  check(
    'active segment is highlighted after selection',
    /color:var\(--accent\)/.test(segList.innerHTML),
    'accent style present',
  );

  // --- switching backend while a comparison is shown swaps the audio -----
  backend.value = 'plain-vocoder';
  backend.trigger('change', { target: { value: 'plain-vocoder' } });
  await sleep(200);
  const plainEvidence = elements.get('evidence').innerHTML;
  check(
    'switching backend keeps a rendered result without re-rendering from scratch',
    /输出样本数/.test(plainEvidence),
    plainEvidence.slice(0, 40),
  );

  elements.get('frame-size').value = '1024';
  elements.get('frame-size').trigger('change', { target: { value: '1024' } });
  await sleep(1200);
  check(
    'changing the window size re-renders with the new frame length',
    /帧长 \/ 帧移（分析）<\/dt><dd class="">1024 \//.test(elements.get('evidence').innerHTML),
    (elements.get('evidence').innerHTML.match(/1024 \/ \d+/) || [''])[0],
  );
} finally {
  try { rmSync(generated); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} DOM wiring checks passed`);
if (failed.length) process.exit(1);
process.exit(0);
