// 에셋(사진·움짤) 레지스트리.
// 상태에는 id만 들어가고 실제 픽셀은 전부 여기에 산다.
// 움짤은 로드 시점에 전 프레임을 ImageBitmap으로 풀어둔다 —
// 내보내기 때 프레임 탐색이 O(1)이 되는 게 이 앱 성능의 핵심이다.
//
// 형식은 GIF, 움직이는 WebP·APNG·AVIF 를 받는다. 어느 쪽이든 여기서 프레임 배열로
// 바뀌고 나면 그리는 쪽과 내보내는 쪽은 원래 형식을 모른다.
//
// 풀어 둔 대가로 메모리를 크게 쓴다. 1920x1080 한 장이 7.9MB 다. 그래서 장수가
// 아니라 픽셀 총량으로 상한을 둔다 — budgetPlan() 참고.

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
 * @property {'image'|'gif'} kind  'gif' 는 '여러 장'이라는 뜻이다. 원본이 WebP·APNG
 *           여도 프레임이 둘 이상이면 'gif' 다. 원본 형식은 여기서 잊는다.
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

/* ---------- 어떤 파일이 '움직이는' 파일인가 ---------- */

/**
 * 앞부분 바이트를 보고 여러 장짜리 그림인지 가린다.
 *
 * 확장자나 MIME 만 보고 고를 수는 없다. WebP 는 요즘 정지 사진 형식으로도 흔하고,
 * PNG 는 스크린샷 형식이라 더 흔하다. 전부 디코더에 넣어 보면 대부분 헛수고가 된다.
 * 헤더에는 애니메이션 여부가 명시돼 있으니 그것만 4KB 읽어 확인한다.
 *
 * @returns {Promise<string|null>} ImageDecoder 에 넘길 MIME. 정지 그림이면 null.
 */
export async function sniffAnimated(blob) {
  let head;
  try {
    head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  } catch {
    return null;
  }
  const at = (o, n) => String.fromCharCode(...head.subarray(o, o + n));
  const has = (tag) => {
    outer: for (let i = 0; i <= head.length - tag.length; i++) {
      for (let j = 0; j < tag.length; j++) if (head[i + j] !== tag.charCodeAt(j)) continue outer;
      return true;
    }
    return false;
  };

  // GIF 는 헤더만으로 장수를 알 수 없다. 한 장짜리 GIF 도 드무니 그냥 디코더에 맡긴다.
  if (at(0, 3) === 'GIF') return 'image/gif';

  // WebP: RIFF....WEBP. 확장 청크 VP8X 의 플래그 바이트에 애니메이션 비트가 있다.
  if (at(0, 4) === 'RIFF' && at(8, 4) === 'WEBP') {
    return at(12, 4) === 'VP8X' && (head[20] & 0x02) ? 'image/webp' : null;
  }

  // APNG: 보통 MIME 이 image/png 로 온다. acTL 청크가 있으면 여러 장이다.
  if (head[0] === 0x89 && at(1, 3) === 'PNG') {
    return has('acTL') ? 'image/png' : null;
  }

  // AVIF 시퀀스: ftyp 상자의 브랜드 목록에 avis 가 들어 있다.
  if (at(4, 4) === 'ftyp') {
    return has('avis') ? 'image/avif' : null;
  }

  return null;
}

/* ---------- 메모리 예산 ---------- */

/**
 * 프레임을 얼마나, 어느 크기로 들고 있을지 정한다.
 *
 * 줄여야 한다면 '축소'를 '솎아내기'보다 먼저 쓴다. 장수를 줄이면 움직임이 끊겨서
 * 바로 티가 나지만, 조금 작아진 건 이 앱에서는 거의 보이지 않는다 — 가장 큰 칸인
 * 말풍선이 700x440 이라 2배로 내보내도 1400x880 이면 충분하다.
 *
 * 배율이 아니라 최종 크기를 돌려준다. 배율을 돌려주면 계획을 세운 쪽과 실제로
 * 줄이는 쪽이 각자 반올림해서 어긋난다 — 그 1픽셀 때문에 예산을 아슬아슬하게
 * 넘겨 멀쩡한 프레임이 한 장 떨어져 나갔다.
 *
 * @returns {{count:number, w:number, h:number}}
 */
export function budgetPlan(w, h, total) {
  const cap = Math.min(total, LIMITS.maxFrames);
  if (!w || !h || cap < 1) return { count: Math.max(cap, 1), w, h };

  const budget = LIMITS.maxAssetPixels;
  if (w * h * cap <= budget) return { count: cap, w, h };

  // 1) 축소로 맞춰 본다. 내림으로 잡아 계산한 예산을 넘지 않게 한다.
  let scale = Math.sqrt(budget / (w * h * cap));
  const edge = Math.max(w, h);
  if (edge * scale < LIMITS.minFrameEdge) scale = Math.min(1, LIMITS.minFrameEdge / edge);
  const tw = Math.max(1, Math.floor(w * scale));
  const th = Math.max(1, Math.floor(h * scale));

  // 2) 바닥(minFrameEdge)에 닿아 그래도 넘치면 그때 솎아낸다.
  const count = Math.max(1, Math.min(cap, Math.floor(budget / (tw * th))));
  return { count, w: tw, h: th };
}

/**
 * total 장 중 n 장만 고를 때, 고른 프레임의 번호와 '넘겨받을 시간'을 정한다.
 *
 * 건너뛴 프레임의 시간은 버리지 않고 바로 앞의 남는 프레임에 얹는다. 그래야 전체
 * 재생 길이가 그대로다. 예전에는 WebCodecs 경로가 뒤를 잘라 버려서 뒷부분이
 * 통째로 사라졌고("재생 길이는 그대로입니다" 라는 안내와 어긋났다), 폴백 경로는
 * 고르게 뽑되 건너뛴 시간을 버려서 재생이 빨라졌다.
 *
 * @returns {number[]} 길이 total. 그 프레임을 남기면 몫 번호(0..n-1), 버리면 -1
 */
export function thinPlan(total, n) {
  const keep = new Array(total).fill(-1);
  if (n >= total) { for (let i = 0; i < total; i++) keep[i] = i; return keep; }
  for (let i = 0; i < n; i++) keep[Math.floor((i * total) / n)] = i;
  return keep;
}

/* ---------- 디코딩 ---------- */

const MIN_DELAY = 20;
const DEFAULT_DELAY = 100;

/** WebCodecs 경로. GIF·WebP·APNG·AVIF 를 모두 같은 방식으로 읽는다. */
async function decodeWithImageDecoder(buffer, mime) {
  if (!('ImageDecoder' in globalThis)) return null;
  try {
    if (ImageDecoder.isTypeSupported && !(await ImageDecoder.isTypeSupported(mime))) return null;
  } catch { /* 물어볼 수 없으면 그냥 해 본다 */ }

  let dec;
  try {
    dec = new ImageDecoder({ data: buffer.slice(0), type: mime });

    // completed 는 '인코딩된 데이터를 다 받았다'는 뜻이지 '장수를 안다'는 뜻이
    // 아니다. 트랙 정보는 tracks.ready 로 따로 기다려야 한다. 이걸 빼먹으면
    // selectedTrack 이 아직 없어서 장수를 1 로 읽고, 움짤이 정지 그림으로 들어간다.
    //
    // GIF 에서는 이 실수가 드러나지 않았다. 예전 코드는 track 이 없으면 예외가 나서
    // 자체 GIF 디코더로 떨어졌고 그쪽이 제대로 읽었기 때문이다. WebP 는 받아 줄
    // 폴백이 없으니 그대로 한 장이 된다.
    await Promise.all([dec.completed, dec.tracks.ready]);

    const track = dec.tracks.selectedTrack;
    if (!track) throw new Error('트랙 없음');
    const total = track.frameCount || 1;
    // 여러 장인 걸 알고 왔는데 한 장으로 읽혔다면 제대로 못 읽은 것이다.
    // 조용히 정지 그림으로 만들지 말고 폴백에 넘긴다.
    if (total < 2 && mime !== 'image/gif') throw new Error('프레임을 못 셈');

    // 크기는 첫 장을 풀어 봐야 안다. 예산 계산에 필요하므로 먼저 한 장만 본다.
    const probe = await dec.decode({ frameIndex: 0 });
    const w = probe.image.displayWidth;
    const h = probe.image.displayHeight;
    probe.image.close();

    const plan = budgetPlan(w, h, total);
    // 앞에서 끊지 않고 전체에 걸쳐 고르게 뽑는다. 건너뛰는 장도 시간을 알아야 하니
    // 풀기는 하지만 바로 닫으므로 쌓이지 않는다.
    const keep = thinPlan(total, plan.count);
    const shrink = plan.w !== w || plan.h !== h;
    const size = shrink
      ? { resizeWidth: plan.w, resizeHeight: plan.h, resizeQuality: 'high' }
      : undefined;

    const frames = [];
    const delays = [];
    let carry = 0;
    // 남길 프레임만 ImageBitmap 으로 만든다. 버릴 프레임도 풀기는 해야 시간을
    // 알 수 있지만, 바로 닫으므로 메모리에 쌓이지 않는다.
    for (let i = 0; i < keep.length; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const d = Math.max(MIN_DELAY, (image.duration || DEFAULT_DELAY * 1000) / 1000);
      if (keep[i] >= 0) {
        frames.push(await createImageBitmap(image, size));
        delays.push(d + carry);
        carry = 0;
      } else {
        carry += d;
      }
      image.close();
    }
    if (carry && delays.length) delays[delays.length - 1] += carry;
    dec.close();

    if (!frames.length) return null;
    return {
      width: frames[0].width, height: frames[0].height, frames, delays,
      dropped: total - frames.length,
      shrunk: shrink ? { w, h } : null,
    };
  } catch {
    try { dec?.close(); } catch { /* 이미 닫혔다 */ }
    return null;
  }
}

/** 예산에 맞춰 이미 풀린 프레임을 솎아낸다. 자체 GIF 디코더 결과에 쓴다. */
async function applyBudget(width, height, frames, delays) {
  const plan = budgetPlan(width, height, frames.length);
  const shrink = plan.w !== width || plan.h !== height;
  if (plan.count >= frames.length && !shrink) {
    return { width, height, frames, delays, shrunk: null };
  }

  const keep = thinPlan(frames.length, plan.count);
  const size = shrink
    ? { resizeWidth: plan.w, resizeHeight: plan.h, resizeQuality: 'high' }
    : undefined;

  const outF = [];
  const outD = [];
  let carry = 0;
  for (let i = 0; i < frames.length; i++) {
    if (keep[i] >= 0) {
      outF.push(size ? await createImageBitmap(frames[i], size) : frames[i]);
      outD.push(delays[i] + carry);
      carry = 0;
      if (size) frames[i].close?.();
    } else {
      carry += delays[i];
      frames[i].close?.();
    }
  }
  if (carry && outD.length) outD[outD.length - 1] += carry;
  return {
    width: outF[0].width, height: outF[0].height, frames: outF, delays: outD,
    shrunk: shrink ? { w: width, h: height } : null,
  };
}

/**
 * 여러 장짜리 그림을 프레임 배열로 푼다.
 * @param {Blob} blob
 * @param {string} mime sniffAnimated 가 정한 형식
 */
async function decodeAnimated(blob, mime) {
  const buffer = await blob.arrayBuffer();

  // 1순위: WebCodecs. 네이티브라 훨씬 빠르고 디스포절 처리도 브라우저가 한다.
  // GIF 말고 다른 형식은 사실상 이 길밖에 없다.
  const native = await decodeWithImageDecoder(buffer, mime);
  if (native) return native;

  // GIF 가 아니면 여기서 끝. 자체 디코더는 GIF 만 읽는다.
  // 정지 그림으로 넣도록 호출부에 알린다. (사파리에 ImageDecoder 가 아직 없다)
  if (mime !== 'image/gif') return null;

  // 2순위: 자체 디코더를 워커에서.
  try {
    const r = await callWorker('decode', { buffer, maxFrames: LIMITS.maxFrames }, [buffer]);
    const out = await applyBudget(r.width, r.height, r.bitmaps, r.delays);
    return { ...out, dropped: r.dropped + (r.bitmaps.length - out.frames.length) };
  } catch {
    // 3순위: 워커도 안 되면 메인 스레드에서. (구형 브라우저)
    const { decodeGif } = await import('./gif/decoder.js');
    const g = decodeGif(await blob.arrayBuffer());
    const frames = [];
    const delays = [];
    for (const f of g.frames) {
      frames.push(await createImageBitmap(new ImageData(f.data, g.width, g.height)));
      delays.push(Math.max(MIN_DELAY, f.delay));
    }
    const out = await applyBudget(g.width, g.height, frames, delays);
    return { ...out, dropped: g.frames.length - out.frames.length };
  }
}

/**
 * 파일/Blob을 에셋으로 등록한다.
 * @returns {Promise<{asset: Asset, warning?: string}>}
 */
export async function createAsset(blob, opts = {}) {
  const mime = await sniffAnimated(blob);
  let width, height, frames, delays, dropped = 0, shrunk = null, noAnim = false;

  const moving = mime ? await decodeAnimated(blob, mime) : null;
  if (moving) {
    ({ width, height, frames, delays, dropped, shrunk } = moving);
  } else {
    // 여러 장짜리인 걸 알면서도 못 풀었다면 이 브라우저에 디코더가 없는 것이다.
    // 첫 장면만이라도 넣고 사실대로 알린다.
    noAnim = !!mime;
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

  const notes = [];
  if (noAnim) {
    notes.push('이 브라우저는 움직이는 WebP·APNG 를 읽지 못합니다. 첫 장면만 넣었습니다.');
  }
  if (shrunk) {
    notes.push(`${shrunk.w}×${shrunk.h} 가 너무 커서 ${width}×${height} 로 줄였습니다.`);
  }
  if (dropped > 0) {
    notes.push(`프레임이 많아 ${frames.length}장으로 솎았습니다. 재생 길이는 그대로입니다.`);
  }
  return { asset, warning: notes.join(' ') || undefined };
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
