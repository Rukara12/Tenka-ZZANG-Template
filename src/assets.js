// 에셋(사진·GIF) 레지스트리.
// 상태에는 id만 들어가고 실제 픽셀은 전부 여기에 산다.
// GIF는 로드 시점에 전 프레임을 ImageBitmap으로 풀어둔다 —
// 내보내기 때 프레임 탐색이 O(1)이 되는 게 이 앱 성능의 핵심이다.

import { LIMITS } from './config.js';
import { store } from './store.js';

let worker = null;
let workerBroken = false;
const pending = new Map();
let seq = 0;

function getWorker() {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./workers/gif.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, result, error, progress } = e.data;
      const entry = pending.get(id);
      if (!entry) return;
      if (progress !== undefined) { entry.onProgress?.(progress); return; }
      pending.delete(id);
      ok ? entry.resolve(result) : entry.reject(new Error(error));
    };
    worker.onerror = () => { workerBroken = true; };
  } catch {
    workerBroken = true;
    return null;
  }
  return worker;
}

function callWorker(type, payload, transfer = [], onProgress) {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('워커 사용 불가'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, type, payload }, transfer);
  });
}

/* ---------- 에셋 레지스트리 ---------- */

const assets = new Map(); // id -> Asset

/**
 * @typedef {object} Asset
 * @property {string} id
 * @property {'image'|'gif'} kind
 * @property {number} width
 * @property {number} height
 * @property {ImageBitmap[]} frames
 * @property {number[]} delays  ms
 * @property {number} duration  ms
 * @property {Blob} blob 원본 (자동 저장/복구용)
 */

export function getAsset(id) {
  return id ? assets.get(id) : undefined;
}

export function allAssetIds() {
  return [...assets.keys()];
}

/** 시간(ms)에 해당하는 프레임 번호. 각 GIF는 자기 고유 속도를 유지한다. */
export function frameIndexAt(asset, timeMs) {
  if (!asset || asset.frames.length === 1 || !asset.duration) return 0;
  let t = timeMs % asset.duration;
  if (t < 0) t += asset.duration;
  let acc = 0;
  for (let i = 0; i < asset.delays.length; i++) {
    acc += asset.delays[i];
    if (t < acc) return i;
  }
  return asset.frames.length - 1;
}

/** 시간(ms)에 해당하는 프레임. */
export function frameAt(asset, timeMs) {
  if (!asset) return null;
  return asset.frames[frameIndexAt(asset, timeMs)];
}

function newId() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function decodeGifBlob(blob) {
  const buffer = await blob.arrayBuffer();

  // 1순위: WebCodecs. 네이티브라 훨씬 빠르고 디스포절 처리도 브라우저가 한다.
  if ('ImageDecoder' in globalThis) {
    try {
      const dec = new ImageDecoder({ data: buffer.slice(0), type: 'image/gif' });
      await dec.completed;
      const track = dec.tracks.selectedTrack;
      const count = Math.min(track.frameCount, LIMITS.maxGifFrames);
      const frames = [];
      const delays = [];
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        frames.push(await createImageBitmap(image));
        delays.push(Math.max(20, (image.duration || 100000) / 1000));
        image.close();
      }
      dec.close();
      if (frames.length) {
        return { width: frames[0].width, height: frames[0].height, frames, delays, dropped: track.frameCount - count };
      }
    } catch { /* 폴백으로 내려간다 */ }
  }

  // 2순위: 자체 디코더를 워커에서.
  try {
    const r = await callWorker('decode', { buffer, maxFrames: LIMITS.maxGifFrames }, [buffer]);
    return { width: r.width, height: r.height, frames: r.bitmaps, delays: r.delays, dropped: r.dropped };
  } catch {
    // 3순위: 워커도 안 되면 메인 스레드에서. (구형 브라우저)
    const { decodeGif } = await import('./gif/decoder.js');
    const buf = await blob.arrayBuffer();
    const g = decodeGif(buf);
    const frames = [];
    const delays = [];
    const count = Math.min(g.frames.length, LIMITS.maxGifFrames);
    for (let i = 0; i < count; i++) {
      const f = g.frames[Math.floor((i * g.frames.length) / count)];
      frames.push(await createImageBitmap(new ImageData(f.data, g.width, g.height)));
      delays.push(f.delay);
    }
    return { width: g.width, height: g.height, frames, delays, dropped: g.frames.length - count };
  }
}

/**
 * 파일/Blob을 에셋으로 등록한다.
 * @returns {Promise<{asset: Asset, warning?: string}>}
 */
export async function createAsset(blob, opts = {}) {
  const isGif = blob.type === 'image/gif' || opts.forceGif;
  let width, height, frames, delays, dropped = 0;

  if (isGif) {
    ({ width, height, frames, delays, dropped } = await decodeGifBlob(blob));
  } else {
    const bmp = await createImageBitmap(blob);
    width = bmp.width; height = bmp.height;
    frames = [bmp];
    delays = [0];
  }

  const id = opts.id || newId();
  const asset = {
    id,
    kind: frames.length > 1 ? 'gif' : 'image',
    width, height, frames, delays,
    duration: delays.reduce((a, b) => a + b, 0) || 0,
    blob,
  };
  assets.set(id, asset);
  if (!opts.skipPersist) store.putBlob(id, blob);

  let warning;
  if (dropped > 0) {
    warning = `프레임이 많아 ${LIMITS.maxGifFrames}장으로 줄였습니다. 재생 길이는 그대로입니다.`;
  }
  return { asset, warning };
}

/** 저장소에서 에셋을 되살린다. */
export async function restoreAsset(id) {
  if (assets.has(id)) return assets.get(id);
  const blob = await store.getBlob(id);
  if (!blob) return null;
  try {
    const { asset } = await createAsset(blob, { id, skipPersist: true });
    return asset;
  } catch {
    return null;
  }
}

/**
 * 안 쓰는 에셋을 메모리에서 내리고, 저장소에서도 정리한다.
 *
 * @param {string[]} usedIds    지금 화면이 쓰는 것 (메모리에 남길 것)
 * @param {string[]} [keepBlobIds] 저장소에 남길 것. 기본값은 usedIds.
 *        보관함이 있으면 반드시 보관함이 참조하는 id 까지 넘겨야 한다 —
 *        지금 작업만 기준으로 지우면 보관해 둔 작업물의 사진이 날아간다.
 */
export function disposeUnused(usedIds, keepBlobIds = usedIds) {
  for (const [id, asset] of assets) {
    if (usedIds.includes(id)) continue;
    for (const f of asset.frames) f.close?.();
    assets.delete(id);
  }
  store.keepOnly(keepBlobIds);
}

/** 워커에 임의 작업을 보낸다. 워커를 못 쓰면 거부되므로 호출부가 폴백을 잡아야 한다. */
export function workerCall(type, payload, transfer = []) {
  return callWorker(type, payload, transfer);
}

export function workerAvailable() {
  return !!getWorker();
}
