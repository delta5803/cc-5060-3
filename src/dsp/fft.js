// Radix-2 complex FFT with precomputed tables. Pure JS, no dependencies.

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export class FFT {
  constructor(size) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.levels = Math.log2(size) | 0;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      const angle = (2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < this.levels; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  // In-place. re/im are Float64Array of length size. inverse scales by 1/size.
  transform(re, im, inverse = false) {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const cos = this.cos;
    const sin = this.sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const wr = cos[k];
          const wi = inverse ? sin[k] : -sin[k];
          const a = start + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    if (inverse) {
      const inv = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] *= inv;
        im[i] *= inv;
      }
    }
  }
}

// Convenience for real input: returns {re, im} full spectra.
export function fftReal(fft, frame) {
  const n = fft.size;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i];
  fft.transform(re, im, false);
  return { re, im };
}
