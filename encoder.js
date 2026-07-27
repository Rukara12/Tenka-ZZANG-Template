// GIF89a 인코더. 외부 의존성 없음.
//
// 스트리밍 구조인 이유: 1024x765 를 2배율로 300프레임 뽑으면 RGBA 원본만 3.7GB다.
// 프레임을 받는 즉시 압축해 버리고, 차분용으로 직전 인덱스 프레임 1장(1byte/px)만 남긴다.

/* ---------- 비트 라이터 (LZW 코드 -> 서브블록) ---------- */

function concat(list) {
  let total = 0;
  for (const c of list) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of list) { out.set(c, o); o += c.length; }
  return out;
}

class BlockWriter {
  constructor() {
    this.chunks = [];
    this.buf = new Uint8Array(255);
    this.len = 0;
    this.bits = 0;
    this.nbits = 0;
  }
  writeCode(code, size) {
    this.bits |= code << this.nbits;
    this.nbits += size;
    while (this.nbits >= 8) {
      this.pushByte(this.bits & 0xff);
      this.bits >>>= 8;
      this.nbits -= 8;
    }
  }
  pushByte(b) {
    this.buf[this.len++] = b;
    if (this.len === 255) this.flushBlock();
  }
  flushBlock() {
    if (this.len === 0) return;
    const out = new Uint8Array(this.len + 1);
    out[0] = this.len;
    out.set(this.buf.subarray(0, this.len), 1);
    this.chunks.push(out);
    this.len = 0;
  }
  finish() {
    if (this.nbits > 0) {
      this.pushByte(this.bits & 0xff);
      this.bits = 0;
      this.nbits = 0;
    }
    this.flushBlock();
    this.chunks.push(new Uint8Array([0])); // 블록 종결자
    return concat(this.chunks);
  }
}

/** 인덱스 배열을 GIF LZW로 압축한다. */
export function lzwEncode(indices, minCodeSize) {
  const w = new BlockWriter();
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = clearCode + 2;
  let dict = new Map();

  w.writeCode(clearCode, codeSize);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }

    w.writeCode(prefix, codeSize);
    if (nextCode < 4096) {
      dict.set(key, nextCode);
      nextCode++;
      // 디코더는 사전 삽입이 한 스텝 늦으므로 인코더 쪽 임계값은 > 가 맞다.
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      w.writeCode(clearCode, codeSize);
      dict = new Map();
      nextCode = clearCode + 2;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  w.writeCode(prefix, codeSize);
  w.writeCode(eoiCode, codeSize);
  return w.finish();
}

/* ---------- 미디안 컷 양자화 ---------- */

function bucketSpans(pixels, idx) {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (let i = 0; i < idx.length; i++) {
    const p = idx[i] * 3;
    const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }
  return [(rMax - rMin) * 0.30, (gMax - gMin) * 0.59, (bMax - bMin) * 0.11];
}

/**
 * RGB 샘플에서 대표색을 뽑는다.
 * @param {Uint8Array} pixels RGB 3바이트 연속
 * @param {number} maxColors
 * @returns {Uint8Array} 팔레트
 */
export function buildPalette(pixels, maxColors) {
  const count = (pixels.length / 3) | 0;
  if (count === 0) return new Uint8Array([0, 0, 0]);

  const seen = new Map();
  for (let i = 0; i < count; i++) {
    const p = i * 3;
    const key = (pixels[p] << 16) | (pixels[p + 1] << 8) | pixels[p + 2];
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const n = seen.size;
  const uniq = new Uint8Array(n * 3);
  const weights = new Float64Array(n);
  let u = 0;
  for (const [key, wgt] of seen) {
    uniq[u * 3] = (key >> 16) & 0xff;
    uniq[u * 3 + 1] = (key >> 8) & 0xff;
    uniq[u * 3 + 2] = key & 0xff;
    weights[u] = wgt;
    u++;
  }
  if (u <= maxColors) return uniq.slice(0, u * 3);

  let buckets = [Array.from({ length: u }, (_, i) => i)];

  while (buckets.length < maxColors) {
    let target = -1, best = -1, axis = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length < 2) continue;
      const sp = bucketSpans(uniq, buckets[i]);
      const m = Math.max(sp[0], sp[1], sp[2]);
      if (m > best) { best = m; target = i; axis = sp.indexOf(m); }
    }
    if (target < 0 || best <= 0) break;

    const bucket = buckets[target];
    bucket.sort((a, b) => uniq[a * 3 + axis] - uniq[b * 3 + axis]);
    let total = 0;
    for (const i of bucket) total += weights[i];
    let acc = 0, cut = 1;
    for (let i = 0; i < bucket.length - 1; i++) {
      acc += weights[bucket[i]];
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    buckets.splice(target, 1, bucket.slice(0, cut), bucket.slice(cut));
  }

  const palette = new Uint8Array(buckets.length * 3);
  buckets.forEach((bucket, i) => {
    let r = 0, g = 0, b = 0, w = 0;
    for (const idx of bucket) {
      const wt = weights[idx];
      r += uniq[idx * 3] * wt;
      g += uniq[idx * 3 + 1] * wt;
      b += uniq[idx * 3 + 2] * wt;
      w += wt;
    }
    palette[i * 3] = Math.round(r / w);
    palette[i * 3 + 1] = Math.round(g / w);
    palette[i * 3 + 2] = Math.round(b / w);
  });
  return palette;
}

/** RGB555 캐시를 쓰는 최근접색 매퍼. */
export function createMapper(palette) {
  const n = palette.length / 3;
  const cache = new Int16Array(32768).fill(-1);
  return function nearest(r, g, b) {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = r - palette[i * 3];
      const dg = g - palette[i * 3 + 1];
      const db = b - palette[i * 3 + 2];
      const d = dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache[key] = best;
    return best;
  };
}

/**
 * 여러 RGBA 프레임에서 색 샘플을 모은다. (팔레트 산출용)
 * @param {Uint8ClampedArray[]} rgbaFrames
 * @param {number} budget 뽑을 픽셀 수
 */
export function sampleColors(rgbaFrames, budget = 90000) {
  const px = rgbaFrames[0].length / 4;
  const total = px * rgbaFrames.length;
  const step = Math.max(1, Math.floor(total / budget));
  const est = Math.ceil(total / step) + rgbaFrames.length + 8;
  const out = new Uint8Array(est * 3);
  let s = 0;
  for (let f = 0; f < rgbaFrames.length; f++) {
    const data = rgbaFrames[f];
    for (let i = (step - ((f * px) % step)) % step; i < px; i += step) {
      const p = i * 4;
      out[s * 3] = data[p];
      out[s * 3 + 1] = data[p + 1];
      out[s * 3 + 2] = data[p + 2];
      s++;
    }
  }
  return out.subarray(0, s * 3);
}

/* ---------- 컨테이너 ---------- */

class ByteStream {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(new Uint8Array([v & 0xff])); }
  u16(v) { this.parts.push(new Uint8Array([v & 0xff, (v >> 8) & 0xff])); }
  bytes(a) { this.parts.push(a); }
  ascii(s) { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); this.bytes(a); }
  take() { const out = concat(this.parts); this.parts = []; return out; }
}

function paletteBits(n) {
  let bits = 1;
  while ((1 << bits) < n) bits++;
  return Math.min(Math.max(bits, 1), 8);
}

/**
 * 프레임을 하나씩 받아 즉시 압축하는 인코더.
 *
 *   const enc = new GifStream({ width, height, palette });
 *   enc.addRGBA(rgba, delayMs);
 *   const bytes = enc.finish();
 */
export class GifStream {
  constructor({ width, height, palette, loop = 0, diff = true }) {
    this.width = width;
    this.height = height;
    this.diff = diff;
    this.palette = palette;
    this.paletteCount = palette.length / 3;
    this.transparentIndex = this.paletteCount;
    this.bits = paletteBits(this.paletteCount + 1);
    this.minCodeSize = Math.max(2, this.bits);
    this.mapper = createMapper(palette);
    this.chunks = [];
    this.prev = null;
    this.frameCount = 0;
    this.byteLength = 0;
    this._lastGce = null;
    this._lastCs = 0;

    const st = new ByteStream();
    st.ascii('GIF89a');
    st.u16(width);
    st.u16(height);
    st.u8(0x80 | ((this.bits - 1) & 0x07));
    st.u8(0);
    st.u8(0);
    const table = new Uint8Array((1 << this.bits) * 3);
    table.set(palette, 0);
    st.bytes(table);
    st.u8(0x21); st.u8(0xff); st.u8(0x0b);
    st.ascii('NETSCAPE2.0');
    st.u8(0x03); st.u8(0x01); st.u16(loop); st.u8(0x00);
    this._push(st.take());
  }

  _push(bytes) {
    this.chunks.push(bytes);
    this.byteLength += bytes.length;
  }

  quantize(rgba) {
    const px = this.width * this.height;
    const out = new Uint8Array(px);
    const map = this.mapper;
    for (let i = 0; i < px; i++) {
      const p = i * 4;
      out[i] = map(rgba[p], rgba[p + 1], rgba[p + 2]);
    }
    return out;
  }

  addRGBA(rgba, delayMs) {
    return this.addIndexed(this.quantize(rgba), delayMs);
  }

  /** @returns {boolean} 실제 기록 여부. false 면 직전 프레임의 표시 시간이 늘어난 것. */
  addIndexed(cur, delayMs) {
    const { width, height } = this;

    let left = 0, top = 0, w = width, h = height;
    let payload = cur;
    let useTransparency = false;

    if (this.diff && this.prev) {
      const prev = this.prev;
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
          if (cur[row + x] !== prev[row + x]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) {
        this._extendLastDelay(delayMs);
        return false;
      }
      left = minX; top = minY;
      w = maxX - minX + 1;
      h = maxY - minY + 1;
      payload = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const src = (top + y) * width + left;
        const dst = y * w;
        for (let x = 0; x < w; x++) {
          const a = cur[src + x];
          if (a === prev[src + x]) { payload[dst + x] = this.transparentIndex; useTransparency = true; }
          else payload[dst + x] = a;
        }
      }
    }

    let cs = Math.round(delayMs / 10);
    if (cs < 2) cs = 2;

    // GCE 를 따로 보관해 두면 나중에 딜레이만 덧쓸 수 있다.
    const gce = new Uint8Array([
      0x21, 0xf9, 0x04,
      (1 << 2) | (useTransparency ? 1 : 0), // disposal = 1 (유지)
      cs & 0xff, (cs >> 8) & 0xff,
      useTransparency ? this.transparentIndex : 0,
      0x00,
    ]);
    this._push(gce);

    const st = new ByteStream();
    st.u8(0x2c);
    st.u16(left); st.u16(top); st.u16(w); st.u16(h);
    st.u8(0x00);
    st.u8(this.minCodeSize);
    st.bytes(lzwEncode(payload, this.minCodeSize));
    this._push(st.take());

    this.prev = cur;
    this.frameCount++;
    this._lastGce = gce;
    this._lastCs = cs;
    return true;
  }

  _extendLastDelay(delayMs) {
    if (!this._lastGce) return;
    const cs = Math.min(65535, this._lastCs + Math.max(1, Math.round(delayMs / 10)));
    this._lastCs = cs;
    this._lastGce[4] = cs & 0xff;
    this._lastGce[5] = (cs >> 8) & 0xff;
  }

  finish() {
    this._push(new Uint8Array([0x3b]));
    return concat(this.chunks);
  }
}

/** 전체 프레임을 한 번에 넘기는 간편 함수 (테스트·소규모용). */
export function encodeGif({ width, height, frames, maxColors = 255, diff = true, loop = 0, onProgress }) {
  const palette = buildPalette(sampleColors(frames.map((f) => f.data)), maxColors);
  const enc = new GifStream({ width, height, palette, diff, loop });
  for (let i = 0; i < frames.length; i++) {
    enc.addRGBA(frames[i].data, frames[i].delay);
    onProgress?.((i + 1) / frames.length);
  }
  return enc.finish();
}
