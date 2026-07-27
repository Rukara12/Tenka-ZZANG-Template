// GIF 디코딩/인코딩을 메인 스레드 밖에서 돌린다.
// 디코딩 결과는 ImageBitmap으로 transfer 하고, 인코딩은 프레임 단위로 받아 즉시 압축한다.

import { decodeGif } from '../gif/decoder.js';
import { GifStream, buildPalette } from '../gif/encoder.js';

const sessions = new Map();

async function handle(type, payload) {
  if (type === 'decode') {
    const { buffer, maxFrames } = payload;
    const g = decodeGif(buffer);

    let frames = g.frames;
    let dropped = 0;
    if (maxFrames && frames.length > maxFrames) {
      // 균등 솎아내되 전체 재생 길이는 보존한다.
      const total = frames.reduce((a, f) => a + f.delay, 0);
      const stride = frames.length / maxFrames;
      const kept = [];
      for (let i = 0; i < maxFrames; i++) kept.push(frames[Math.floor(i * stride)]);
      const each = total / maxFrames;
      for (const f of kept) f.delay = each;
      dropped = frames.length - maxFrames;
      frames = kept;
    }

    const bitmaps = [];
    const delays = [];
    for (const f of frames) {
      bitmaps.push(await createImageBitmap(new ImageData(f.data, g.width, g.height)));
      delays.push(f.delay);
    }
    return {
      result: { width: g.width, height: g.height, bitmaps, delays, dropped },
      transfer: bitmaps,
    };
  }

  if (type === 'palette') {
    const palette = buildPalette(new Uint8Array(payload.samples), payload.maxColors ?? 255);
    return { result: { palette }, transfer: [palette.buffer] };
  }

  if (type === 'gifInit') {
    const { session, width, height, palette, diff } = payload;
    sessions.set(session, new GifStream({ width, height, palette: new Uint8Array(palette), diff }));
    return { result: { ok: true } };
  }

  if (type === 'gifFrame') {
    const enc = sessions.get(payload.session);
    if (!enc) throw new Error('인코딩 세션이 없습니다.');
    const wrote = enc.addRGBA(new Uint8ClampedArray(payload.rgba), payload.delay);
    return { result: { wrote, frames: enc.frameCount, bytes: enc.byteLength } };
  }

  if (type === 'gifFinish') {
    const enc = sessions.get(payload.session);
    if (!enc) throw new Error('인코딩 세션이 없습니다.');
    sessions.delete(payload.session);
    const bytes = enc.finish();
    return { result: { bytes, frames: enc.frameCount }, transfer: [bytes.buffer] };
  }

  if (type === 'gifAbort') {
    sessions.delete(payload.session);
    return { result: { ok: true } };
  }

  throw new Error(`알 수 없는 작업: ${type}`);
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    const { result, transfer } = await handle(type, payload);
    self.postMessage({ id, ok: true, result }, transfer || []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
