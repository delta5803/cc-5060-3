// Minimal RIFF/WAVE reader and writer. Supports PCM 16/24/32-bit and float32.

export function parseWav(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const tag = (off) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bits: view.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe && size >= 40) {
        fmt.format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, bytes.length - body);
    }
    off = body + size + (size & 1);
    if (size === 0 && id !== 'fmt ' && id !== 'data') break;
  }
  if (!fmt || dataOff < 0) throw new Error('Missing fmt or data chunk');

  const ch = fmt.channels;
  const frames = Math.floor(dataLen / (fmt.blockAlign || ch * (fmt.bits / 8)));
  const out = [];
  for (let c = 0; c < ch; c++) out.push(new Float32Array(frames));

  const bps = fmt.bits / 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const p = dataOff + i * fmt.blockAlign + c * bps;
      let v;
      if (fmt.format === 3 && fmt.bits === 32) v = view.getFloat32(p, true);
      else if (fmt.format === 3 && fmt.bits === 64) v = view.getFloat64(p, true);
      else if (fmt.bits === 16) v = view.getInt16(p, true) / 32768;
      else if (fmt.bits === 24) {
        const b0 = bytes[p], b1 = bytes[p + 1], b2 = bytes[p + 2];
        let x = b0 | (b1 << 8) | (b2 << 16);
        if (x & 0x800000) x |= 0xff000000;
        v = x / 8388608;
      } else if (fmt.bits === 32) v = view.getInt32(p, true) / 2147483648;
      else if (fmt.bits === 8) v = (view.getUint8(p) - 128) / 128;
      else throw new Error(`Unsupported bits: ${fmt.bits}`);
      out[c][i] = v;
    }
  }
  return { sampleRate: fmt.sampleRate, channels: out, bits: fmt.bits, format: fmt.format };
}

// channels: array of Float32Array/Float64Array, all same length.
export function encodeWav(channels, sampleRate, bits = 16) {
  const ch = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bits / 8;
  const blockAlign = ch * bytesPerSample;
  const dataLen = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const writeTag = (off, s) => {
    for (let i = 0; i < 4; i++) bytes[off + i] = s.charCodeAt(i);
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  writeTag(36, 'data');
  view.setUint32(40, dataLen, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let v = channels[c][i];
      v = Math.max(-1, Math.min(1, v));
      if (bits === 16) {
        view.setInt16(p, Math.round(v < 0 ? v * 32768 : v * 32767), true);
        p += 2;
      } else if (bits === 24) {
        let x = Math.round(v < 0 ? v * 8388608 : v * 8388607);
        if (x < 0) x += 0x1000000;
        bytes[p] = x & 0xff;
        bytes[p + 1] = (x >> 8) & 0xff;
        bytes[p + 2] = (x >> 16) & 0xff;
        p += 3;
      } else if (bits === 32) {
        view.setInt32(p, Math.round(v < 0 ? v * 2147483648 : v * 2147483647), true);
        p += 4;
      } else throw new Error(`Unsupported bits: ${bits}`);
    }
  }
  return new Uint8Array(buf);
}
