// Spectral peak detection with parabolic refinement, plus peak tracking.
// The tracker keeps a stable identity for partials across frames so that
// synthesis phase can be accumulated per partial rather than per bin.

export const TAU = 2 * Math.PI;

export function wrapPhase(x) {
  // Map to (-pi, pi].
  const y = (x + Math.PI) % TAU;
  return (y < 0 ? y + TAU : y) - Math.PI;
}

export function detectPeaks(mag, re, im, nfft, sampleRate, opts = {}) {
  const half = nfft >> 1;
  const relFloor = opts.relFloor ?? 1e-3;
  const maxPeaks = opts.maxPeaks ?? 48;
  let maxMag = 0;
  for (let k = 1; k < half; k++) if (mag[k] > maxMag) maxMag = mag[k];
  if (maxMag <= 0) return [];

  const floor = Math.max(maxMag * relFloor, 1e-12);
  const peaks = [];
  for (let k = 2; k < half - 1; k++) {
    const a = mag[k - 1], b = mag[k], c = mag[k + 1];
    if (b < floor) continue;
    if (!(b > a && b >= c)) continue;
    const denom = a - 2 * b + c;
    let delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    if (!Number.isFinite(delta)) delta = 0;
    delta = Math.max(-0.5, Math.min(0.5, delta));
    const amp = b - 0.25 * (a - c) * delta;
    const fracBin = k + delta;
    const phase = Math.atan2(im[k], re[k]);
    peaks.push({
      bin: k,
      fracBin,
      amp,
      phase,
      re: re[k],
      im: im[k],
      hz: (fracBin * sampleRate) / nfft,
      omega: (TAU * k) / nfft,
      instOmega: (TAU * k) / nfft,
      trackId: -1,
    });
  }
  peaks.sort((p, q) => q.amp - p.amp);
  const kept = peaks.length > maxPeaks ? peaks.slice(0, maxPeaks) : peaks;
  kept.sort((p, q) => p.fracBin - q.fracBin);
  return kept;
}

// Instantaneous frequency estimate from the phase increment between two frames.
// prev is {mag, re, im} of the previous analysis frame or null.
export function refineInstantaneousFrequency(peaks, prev, hop, nfft) {
  if (!prev) return;
  for (const p of peaks) {
    const k = p.bin;
    if (k < prev.mag.length && prev.mag[k] > 1e-12 && p.amp > 0) {
      const prevPhase = Math.atan2(prev.im[k], prev.re[k]);
      const expected = (TAU * k * hop) / nfft;
      const delta = wrapPhase(p.phase - prevPhase - expected);
      p.instOmega = (TAU * k) / nfft + delta / hop;
    } else {
      p.instOmega = (TAU * p.fracBin) / nfft;
    }
    // Guard against nonsense from bins whose phase was near-zero noise.
    const limit = (TAU * 1.5) / nfft; // at most 1.5 bins away from nominal
    p.instOmega = Math.max(p.omega - limit, Math.min(p.omega + limit, p.instOmega));
  }
}

export class PeakTracker {
  constructor(opts = {}) {
    this.toleranceHz = opts.toleranceHz ?? 25;
    this.toleranceRatio = opts.toleranceRatio ?? 0.025;
    this.maxGapFrames = opts.maxGapFrames ?? 2;
    this.tracks = new Map();
    this.nextId = 1;
    this.frame = -1;
  }

  // Returns the peaks annotated with trackId and isNew.
  update(peaks) {
    this.frame++;
    const frame = this.frame;
    const unmatchedTracks = new Set(this.tracks.keys());
    const result = [];

    // Greedy nearest-frequency matching, deterministic by sorted frequency.
    const sorted = [...peaks].sort((a, b) => a.fracBin - b.fracBin);
    const usedTrack = new Set();
    for (const p of sorted) {
      let best = null;
      let bestDist = Infinity;
      for (const [id, t] of this.tracks) {
        if (usedTrack.has(id)) continue;
        if (frame - t.lastFrame > this.maxGapFrames + 1) continue;
        const dist = Math.abs(p.hz - t.hz);
        const tol = Math.max(this.toleranceHz, this.toleranceRatio * t.hz);
        if (dist <= tol && dist < bestDist) {
          best = id;
          bestDist = dist;
        }
      }
      if (best !== null) {
        const t = this.tracks.get(best);
        t.hz = 0.65 * t.hz + 0.35 * p.hz;
        t.lastFrame = frame;
        t.amp = p.amp;
        p.trackId = best;
        p.isNew = false;
        usedTrack.add(best);
        unmatchedTracks.delete(best);
      } else {
        const id = this.nextId++;
        this.tracks.set(id, {
          id,
          hz: p.hz,
          lastFrame: frame,
          amp: p.amp,
          synthPhase: null,
          synthFrame: null,
        });
        p.trackId = id;
        p.isNew = true;
        usedTrack.add(id);
      }
      result.push(p);
    }

    // Expire tracks that have been silent for too long.
    for (const [id, t] of this.tracks) {
      if (frame - t.lastFrame > this.maxGapFrames) this.tracks.delete(id);
    }
    return result;
  }
}
