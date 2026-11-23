import { chromium } from 'playwright-core';
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1100,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://127.0.0.1:5173/',{waitUntil:'networkidle'});
// initial state
await p.screenshot({path:'/workspace/outputs/ui_state_initial.png'});
// load wav via file input
const fs=await import('node:fs');
await p.setInputFiles('#file', '/workspace/outputs/case5_dense_chord_input.wav');
await p.waitForTimeout(800);
const name=await p.textContent('#track-name');
console.log('loaded:', name);
await p.screenshot({path:'/workspace/outputs/ui_state_loaded.png'});
// play B without render -> error
await p.click('#play-b');
await p.waitForTimeout(300);
console.log('err shown:', await p.getAttribute('#error','class'), '|', (await p.textContent('#error')).slice(0,60));
// narrow viewport check
await p.setViewportSize({width:760,height:900});
await p.waitForTimeout(300);
await p.screenshot({path:'/workspace/outputs/ui_state_narrow.png'});
console.log('page errors:', errs.length? errs: 'none');
await b.close();
