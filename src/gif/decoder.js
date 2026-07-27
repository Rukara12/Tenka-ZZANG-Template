// GIF87a/89a 디코더. 디스포절 처리 포함, 프레임마다 완성된 RGBA를 돌려준다.
// ImageDecoder(WebCodecs)를 못 쓰는 브라우저용 폴백이자 워커에서 쓰는 기본 경로.

const DISPOSE_NONE = 1;
const DISPOSE_BACKGROUND = 2;
const DISPOSE_PREVIOUS = 3;

function lzwDecode(bytes, minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  // 사전은 (prefix, suffix) 배열로 둔다. 배열 concat보다 훨씬 빠르다.
  const prefixOf = new Int32Array(4096);
  const suffixOf = new Uint8Array(4096);
  const firstOf = new Uint8Array(4096);
  for (let i = 0; i < clearCode; i++) { prefixOf[i] = -1; suffixOf[i] = i; firstOf[i] = i; }

  const out = new Uint8Array(pixelCount);
  const stack = new Uint8Array(4096);
  let outPos = 0;

  let codeSize = minCodeSize + 1;
  let nextCode = clearCode + 2;
  let mask = (1 << codeSize) - 1;

  let bitPos = 0;
  const totalBits = bytes.length * 8;
  let prevCode = -1;

  while (outPos < pixelCount) {
    if (bitPos + codeSize > totalBits) break;
    const bytePos = bitPos >> 3;
    const chunk = bytes[bytePos] | (bytes[bytePos + 1] << 8) | (bytes[bytePos + 2] << 16);
    const code = (chunk >>> (bitPos & 7)) & mask;
    bitPos += codeSize;

    if (code === eoiCode) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = clearCode + 2;
      mask = (1 << codeSize) - 1;
      prevCode = -1;
      continue;
    }

    if (prevCode === -1) {
      if (code >= clearCode) break;
      out[outPos++] = code;
      prevCode = code;
      continue;
    }

    let sp = 0;
    let cur = code;
    if (code >= nextCode) {
      // KwKwK: 아직 사전에 없는 코드. 직전 시퀀스 + 그 첫 글자.
      if (code > nextCode) break; // 손상된 스트림
      stack[sp++] = firstOf[prevCode];
      cur = prevCode;
    }
    while (cur >= clearCode) {
      stack[sp++] = suffixOf[cur];
      cur = prefixOf[cur];
      if (cur < 0 || sp >= 4095) { cur = 0; break; }
    }
    stack[sp++] = cur;
    const first = cur; // 이번 시퀀스의 첫 글자

    for (let i = sp - 1; i >= 0 && outPos < pixelCount; i--) out[outPos++] = stack[i];

    if (nextCode < 4096) {
      prefixOf[nextCode] = prevCode;
      suffixOf[nextCode] = first;
      firstOf[nextCode] = firstOf[prevCode];
      nextCode++;
      if (nextCode > mask && codeSize < 12) { codeSize++; mask = (1 << codeSize) - 1; }
    }
    prevCode = code;
  }
  return out;
}

class Reader {
  constructor(buf) { this.d = new Uint8Array(buf); this.p = 0; }
  u8() { return this.d[this.p++]; }
  u16() { const v = this.d[this.p] | (this.d[this.p + 1] << 8); this.p += 2; return v; }
  bytes(n) { const v = this.d.subarray(this.p, this.p + n); this.p += n; return v; }
  ascii(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.d[this.p++]); return s; }
  skipSubBlocks() { let n; while ((n = this.u8())) this.p += n; }
  readSubBlocks() {
    const parts = []; let total = 0, n;
    while ((n = this.u8())) { parts.push(this.bytes(n)); total += n; }
    const out = new Uint8Array(total); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/**
 * GIF 바이트를 디코딩한다.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{width:number, height:number, frames:Array<{data:Uint8ClampedArray, delay:number}>}}
 *          delay 단위는 ms. data는 캔버스 전체 크기의 완성된 RGBA.
 */
export function decodeGif(buffer) {
  const r = new Reader(buffer);
  const sig = r.ascii(6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('GIF 파일이 아닙니다.');

  const width = r.u16();
  const height = r.u16();
  const packed = r.u8();
  r.u8(); // 배경색 인덱스
  r.u8(); // 픽셀 종횡비

  let gct = null;
  if (packed & 0x80) gct = r.bytes(3 * (1 << ((packed & 0x07) + 1)));

  const frames = [];
  const px = width * height;
  const canvas = new Uint8ClampedArray(px * 4);
  let saved = null;

  let delay = 100;
  let transparentIndex = -1;
  let disposal = DISPOSE_NONE;

  for (;;) {
    const block = r.u8();
    if (block === 0x3b || block === undefined) break;

    if (block === 0x21) {
      const label = r.u8();
      if (label === 0xf9) {
        r.u8(); // 블록 크기 (4)
        const flags = r.u8();
        disposal = (flags >> 2) & 0x07;
        transparentIndex = flags & 0x01 ? -2 : -1; // 나중에 실제 인덱스로 교체
        const cs = r.u16();
        delay = cs * 10;
        const ti = r.u8();
        transparentIndex = transparentIndex === -2 ? ti : -1;
        r.u8(); // 종결자
      } else {
        r.skipSubBlocks();
      }
      continue;
    }

    if (block !== 0x2c) continue; // 알 수 없는 블록은 무시

    const left = r.u16(), top = r.u16(), fw = r.u16(), fh = r.u16();
    const fPacked = r.u8();
    const interlaced = !!(fPacked & 0x40);
    let table = gct;
    if (fPacked & 0x80) table = r.bytes(3 * (1 << ((fPacked & 0x07) + 1)));
    if (!table) throw new Error('색상 테이블이 없는 GIF입니다.');

    const minCodeSize = r.u8();
    const data = r.readSubBlocks();
    const indices = lzwDecode(data, minCodeSize, fw * fh);

    if (disposal === DISPOSE_PREVIOUS) saved = canvas.slice();

    // 프레임 픽셀을 캔버스에 합성
    const rows = interlaced ? deinterlaceRows(fh) : null;
    for (let y = 0; y < fh; y++) {
      const srcY = rows ? rows[y] : y;
      const cy = top + srcY;
      if (cy < 0 || cy >= height) continue;
      for (let x = 0; x < fw; x++) {
        const cx = left + x;
        if (cx < 0 || cx >= width) continue;
        const idx = indices[y * fw + x];
        if (idx === transparentIndex) continue;
        const s = idx * 3;
        const d = (cy * width + cx) * 4;
        canvas[d] = table[s];
        canvas[d + 1] = table[s + 1];
        canvas[d + 2] = table[s + 2];
        canvas[d + 3] = 255;
      }
    }

    frames.push({ data: canvas.slice(), delay: delay > 0 ? delay : 100 });

    if (disposal === DISPOSE_BACKGROUND) {
      for (let y = 0; y < fh; y++) {
        const cy = top + y;
        if (cy < 0 || cy >= height) continue;
        for (let x = 0; x < fw; x++) {
          const cx = left + x;
          if (cx < 0 || cx >= width) continue;
          const d = (cy * width + cx) * 4;
          canvas[d] = canvas[d + 1] = canvas[d + 2] = canvas[d + 3] = 0;
        }
      }
    } else if (disposal === DISPOSE_PREVIOUS && saved) {
      canvas.set(saved);
    }

    delay = 100;
    transparentIndex = -1;
    disposal = DISPOSE_NONE;
  }

  if (!frames.length) throw new Error('프레임을 찾지 못했습니다.');
  return { width, height, frames };
}

function deinterlaceRows(h) {
  const rows = new Int32Array(h);
  let i = 0;
  for (let y = 0; y < h; y += 8) rows[i++] = y;
  for (let y = 4; y < h; y += 8) rows[i++] = y;
  for (let y = 2; y < h; y += 4) rows[i++] = y;
  for (let y = 1; y < h; y += 2) rows[i++] = y;
  return rows;
}
