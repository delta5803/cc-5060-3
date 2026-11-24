// Editable harmonic sources for the compatibility fixture library.
//
// A source is plain JSON: partials, an onset position, an envelope and the
// scenario it exercises. The same definition drives three independent things:
//   1. the input sample (synthesised here),
//   2. a reference rendered directly from the original harmonics, and
//   3. the analytic per-partial targets used to score a backend's output.
// Nothing audio is hand-maintained; editing a source and running the build is
// enough to refresh every derived compatibility artefact.

export const SOURCE_SCHEMA = 'spectral-transposer/source@1';

export const SCENARIOS = Object.freeze([
  'stable-dual',
  'short-attack',
  'attack-window-edge',
]);

export function sourceOnsetSample(def) {
  if (Number.isFinite(def.onsetSample)) return Math.max(0, Math.round(def.onsetSample));
  return Math.max(0, Math.round((def.onsetSec ?? 0) * def.sampleRate));
}

export function noteSeconds(def) {
  return Math.max(0, def.durationSec - sourceOnsetSample(def) / def.sampleRate);
}

export function envelopeAt(localSec, noteSec, env = {}) {
  if (localSec < 0 || localSec > noteSec) return 0;
  const attack = Math.max(0, env.attackSec ?? 0.005);
  const release = Math.max(0, env.releaseSec ?? 0.02);
  let value = 1;
  if (attack > 0 && localSec < attack) value = localSec / attack;
  if (release > 0 && localSec > noteSec - release) {
    value *= Math.max(0, (noteSec - localSec) / release);
  }
  return value;
}

// Synthesise the source at its own pitch. This is the editable ground truth
// that gets written to disk as the fixture input.
//
// A definition is either a single note (`partials` + `onsetSec`/`onsetSample`
// + `envelope`) or a phrase (`events`, each a short note with its own pitch).
// Phrase events let legacy-project fixtures place a re-attack at a known time
// marker while a first note is still sounding.
export function renderSource(def) {
  const sr = def.sampleRate;
  const n = Math.round(def.durationSec * sr);
  const out = new Float32Array(n);
  if (Array.isArray(def.events) && def.events.length) {
    for (const ev of def.events) {
      const s = Math.max(0, Math.round((ev.startSec ?? 0) * sr));
      const e = Math.min(n, Math.round(((ev.startSec ?? 0) + (ev.durSec ?? 0)) * sr));
      const attack = Math.max(0, ev.attackSec ?? 0.003);
      const decay = ev.decayPerSec ?? 0.5;
      const partials = ev.partials || def.partials;
      for (let i = s; i < e; i++) {
        const local = (i - s) / sr;
        let env = attack > 0 && local < attack ? local / attack : Math.exp(-decay * Math.max(0, local - attack));
        if (ev.releaseSec > 0 && local > (ev.durSec ?? 0) - ev.releaseSec) {
          env *= Math.max(0, ((ev.durSec ?? 0) - local) / ev.releaseSec);
        }
        const t = i / sr;
        let ssum = 0;
        for (const p of partials) {
          ssum += (p.amp ?? 0.3) * Math.sin(2 * Math.PI * p.hz * t + (p.phase ?? 0));
        }
        out[i] += env * ssum;
      }
    }
    return out;
  }
  const onset = sourceOnsetSample(def);
  const noteSec = noteSeconds(def);
  const env = def.envelope || {};
  for (let i = 0; i < n; i++) {
    const local = (i - onset) / sr;
    const e = envelopeAt(local, noteSec, env);
    if (e === 0) continue;
    const t = i / sr;
    let s = 0;
    for (const p of def.partials) {
      const phase = p.phase ?? 0;
      s += (p.amp ?? 0.3) * Math.sin(2 * Math.PI * p.hz * t + phase);
    }
    out[i] = e * s;
  }
  return out;
}

// Reference at the transposed pitch, rebuilt from the *original harmonics*
// (hz * ratio), with the same onset and envelope. Length equals the input so
// the reference can be measured by exactly the same tools as a backend output.
export function renderReference(def, ratio) {
  const sr = def.sampleRate;
  const n = Math.round(def.durationSec * sr);
  const out = new Float32Array(n);
  if (Array.isArray(def.events) && def.events.length) {
    for (const ev of def.events) {
      const s = Math.max(0, Math.round((ev.startSec ?? 0) * sr));
      const e = Math.min(n, Math.round(((ev.startSec ?? 0) + (ev.durSec ?? 0)) * sr));
      const attack = Math.max(0, ev.attackSec ?? 0.003);
      const decay = ev.decayPerSec ?? 0.5;
      const partials = ev.partials || def.partials;
      for (let i = s; i < e; i++) {
        const local = (i - s) / sr;
        let env = attack > 0 && local < attack ? local / attack : Math.exp(-decay * Math.max(0, local - attack));
        if (ev.releaseSec > 0 && local > (ev.durSec ?? 0) - ev.releaseSec) {
          env *= Math.max(0, ((ev.durSec ?? 0) - local) / ev.releaseSec);
        }
        const t = i / sr;
        let ssum = 0;
        for (const p of partials) {
          ssum += (p.amp ?? 0.3) * Math.sin(2 * Math.PI * p.hz * ratio * t + (p.phase ?? 0));
        }
        out[i] += env * ssum;
      }
    }
    return out;
  }
  const onset = sourceOnsetSample(def);
  const noteSec = noteSeconds(def);
  const env = def.envelope || {};
  for (let i = 0; i < n; i++) {
    const local = (i - onset) / sr;
    const e = envelopeAt(local, noteSec, env);
    if (e === 0) continue;
    const t = i / sr;
    let s = 0;
    for (const p of def.partials) {
      // Original harmonic regenerated at its shifted frequency; keep the
      // source phase so the reference is a direct, deterministic transform.
      s += (p.amp ?? 0.3) * Math.sin(2 * Math.PI * p.hz * ratio * t + (p.phase ?? 0));
    }
    out[i] = e * s;
  }
  return out;
}

export function targetPartials(def, ratio) {
  return def.partials.map((p) => ({
    sourceHz: p.hz,
    targetHz: p.hz * ratio,
    amp: p.amp ?? 0.3,
  }));
}

export function analyticTargets(def, ratio, fromSample, toSample) {
  const sr = def.sampleRate;
  return targetPartials(def, ratio).map((p) => ({
    ...p,
    cents: 0,
    window: [fromSample, toSample],
    ampExpected: p.amp,
    reference: 'analytic harmonics (hz * ratio)',
    note: 'Expected value is analytic; use renderReference() to measure a regenerated control instead.',
    sampleRate: sr,
  }));
}

// A source-set is one editable file per scenario that lists rate variants.
// Expanding it yields fully-specified source definitions, so the audio is
// regenerated rather than stored: editing this JSON is all a maintainer does.
export function expandSourceSet(set) {
  const defs = [];
  for (const variant of set.variants || []) {
    const def = {
      schema: SOURCE_SCHEMA,
      id: `${set.id}@${variant.sampleRate}`,
      setId: set.id,
      scenario: set.scenario,
      sampleRate: variant.sampleRate,
      durationSec: variant.durationSec,
      onsetSample: variant.onsetSample,
      onsetSec: variant.onsetSample / variant.sampleRate,
      partials: set.partials,
      envelope: set.envelope,
      note: set.note ?? null,
      nearWindowEdge: set.nearWindowEdge === true,
    };
    defs.push(def);
  }
  return defs;
}

export function validateSourceSet(set) {
  const issues = [];
  if (!set || typeof set !== 'object') return ['source-set is not an object'];
  if (!set.id) issues.push('id missing');
  if (set.scenario && !SCENARIOS.includes(set.scenario)) issues.push('unknown scenario ' + set.scenario);
  if (!Array.isArray(set.variants) || set.variants.length === 0) issues.push('variants must be non-empty');
  for (const [i, v] of (set.variants || []).entries()) {
    if (!(v.sampleRate > 0)) issues.push(`variants[${i}].sampleRate invalid`);
    if (!(v.durationSec > 0)) issues.push(`variants[${i}].durationSec invalid`);
    if (!Number.isFinite(v.onsetSample)) issues.push(`variants[${i}].onsetSample missing`);
  }
  if (!Array.isArray(set.partials) || set.partials.length === 0) issues.push('partials must be non-empty');
  return issues;
}

export function validateSource(def) {
  const issues = [];
  if (!def || typeof def !== 'object') return ['source is not an object'];
  if (def.schema && def.schema !== SOURCE_SCHEMA) issues.push('schema ' + def.schema);
  if (!(def.sampleRate > 0)) issues.push('sampleRate must be positive');
  if (!(def.durationSec > 0)) issues.push('durationSec must be positive');
  if (!Array.isArray(def.partials) || def.partials.length === 0) issues.push('partials must be non-empty');
  if (Array.isArray(def.partials)) {
    for (const [i, p] of def.partials.entries()) {
      if (!(p.hz > 0)) issues.push('partials[' + i + '].hz must be positive');
      if (p.amp !== undefined && !(p.amp >= 0)) issues.push('partials[' + i + '].amp must be >= 0');
    }
  }
  if (def.scenario && !SCENARIOS.includes(def.scenario)) issues.push('unknown scenario ' + def.scenario);
  const onset = sourceOnsetSample(def);
  if (onset >= Math.round((def.durationSec || 0) * (def.sampleRate || 1))) {
    issues.push('onset is beyond the source duration');
  }
  return issues;
}
