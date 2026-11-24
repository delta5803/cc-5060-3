// Minimal DOM/browser shim so the page's real <script type="module"> can run
// under Node for logic-level checks when no browser binary is available.
//
// This is deliberately small: it supports exactly the element surface the
// spectral editing window uses (ids, innerHTML, classList, canvas 2d, event
// listeners, fetch from disk). It is not a general DOM implementation and it
// proves wiring and computation, not visuals.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function makeClassList(el) {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    _set: set,
  };
}

function makeCanvasCtx() {
  const noop = () => {};
  return {
    setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop,
    closePath: noop, arc: noop, drawImage: noop, fillText: noop,
    setLineDash: noop, save: noop, restore: noop,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
    imageSmoothingEnabled: true,
  };
}

class StubElement {
  constructor(tag = 'div', id = null) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this._text = '';
    this._html = '';
    this.className = '';
    this.classList = makeClassList(this);
    this.style = {};
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.files = [];
    this.dataset = {};
    this.children = [];
    this.width = 800;
    this.height = 300;
    this._listeners = new Map();
  }

  get textContent() { return this._text || stripTags(this._html); }
  set textContent(v) { this._text = String(v); }

  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    // Materialise clickable rows so the page's delegated-ish handlers can be
    // exercised: renderCompat builds rows with data-seg="i" and attaches a
    // listener to each.
    this.children = [];
    const re = /data-seg="(\d+)"/g;
    let m;
    while ((m = re.exec(this._html))) {
      const child = new StubElement('div');
      child.dataset.seg = m[1];
      child._parent = this;
      this.children.push(child);
    }
  }

  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._listeners.get(type) || [];
    this._listeners.set(type, a.filter((x) => x !== fn));
  }
  trigger(type, event = {}) {
    const ev = { target: this, preventDefault() {}, ...event };
    for (const fn of this._listeners.get(type) || []) fn(ev);
  }
  click() { this.trigger('click'); }
  querySelectorAll(sel) {
    if (sel === '[data-seg]') return this.children.filter((c) => c.dataset.seg !== undefined);
    return [];
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { width: 800, height: 300, left: 0, top: 0 }; }
  getContext() { return this._ctx || (this._ctx = makeCanvasCtx()); }
}

function stripTags(html) { return html.replace(/<[^>]*>/g, ''); }

export function installDom({ root, reportPath = null }) {
  const ids = [...readFileSync(join(root, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)]
    .map((m) => m[1]);
  const elements = new Map();
  for (const id of ids) {
    const tag = id.includes('spectrum') || id === 'trace' ? 'canvas' : 'div';
    elements.set(id, new StubElement(tag, id));
  }
  // Defaults the page relies on before it sets them.
  elements.get('semitones').value = '7';
  elements.get('semitones-num').value = '7';
  elements.get('threshold').value = '0.5';
  elements.get('threshold-num').value = '0.5';
  elements.get('mode').value = 'auto';
  elements.get('phaselock').checked = true;
  elements.get('adaptive').checked = true;
  elements.get('frame-size').value = '2048';

  const document = {
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: (sel) => (sel === '[data-st]' ? [] : []),
    querySelector: () => null,
    createElement: (tag) => new StubElement(tag),
  };

  class StubAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() {}
    createBuffer(ch, len, sr) {
      return { length: len, sampleRate: sr, copyToChannel() {}, getChannelData: () => new Float32Array(len) };
    }
    createBufferSource() {
      return {
        playbackRate: { value: 1 }, buffer: null, loop: false, loopStart: 0, loopEnd: 0,
        connect() {}, start() {}, stop() {}, onended: null,
      };
    }
  }

  const fetch = async (url) => {
    const rel = String(url).replace(/^\.?\//, '').replace(/^outputs\//, 'outputs/');
    const tried = [
      join(root, rel),
      join(root, rel.replace(/^outputs\/compat\//, 'outputs/compat/')),
    ];
    for (const p of tried) {
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf8');
        return { ok: true, status: 200, async json() { return JSON.parse(text); }, async text() { return text; } };
      }
    }
    return { ok: false, status: 404, async json() { throw new Error('not found ' + url); }, async text() { return ''; } };
  };

  const g = globalThis;
  g.window = {
    devicePixelRatio: 1,
    addEventListener: () => {},
    AudioContext: StubAudioContext,
  };
  g.document = document;
  g.fetch = fetch;
  g.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
  g.AudioContext = StubAudioContext;
  if (!g.Blob) g.Blob = class { constructor() {} };
  if (!g.URL.createObjectURL) g.URL.createObjectURL = () => 'blob:stub';
  if (!g.URL.revokeObjectURL) g.URL.revokeObjectURL = () => {};

  return { elements, document };
}

export function extractModuleScript(root) {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no module script in index.html');
  return m[1];
}
