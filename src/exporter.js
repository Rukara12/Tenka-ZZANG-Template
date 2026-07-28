// 내보내기.
// 프레임 시각을 프리뷰와 똑같이 계산하므로 "미리보기와 결과물이 다른" 문제가 없다.

import { CANVAS, LIMITS } from './config.js';
import { getAsset, frameIndexAt, workerCall, workerAvailable } from './assets.js';
import { drawScene } from './renderer.js';
import { sampleColors, buildPalette, GifStream } from './gif/encoder.js';

/** 장면에 움직이는 소스가 있는지, 있다면 한 바퀴 도는 데 얼마나 걸리는지. */
export function sceneTiming(state) {
  let duration = 0;
  let fastest = Infinity;
  let animated = false;
  for (const key of Object.keys(state.slots)) {
    const asset = getAsset(state.slots[key]?.asset);
    if (!asset || asset.kind !== 'gif') continue;
    animated = true;
    duration = Math.max(duration, asset.duration);
    for (const d of asset.delays) if (d > 0) fastest = Math.min(fastest, d);
  }
  const nativeFps = fastest === Infinity ? 0 : Math.min(50, Math.round(1000 / fastest));
  return { animated, duration, nativeFps };
}

/**
 * 내보내기 계획을 세운다. 대화상자에서 미리 보여줄 숫자들.
 */
export function planExport(state, opts) {
  const { fps, speed = 1, scale = 1 } = opts;
  const t = sceneTiming(state);
  if (!t.animated) {
    return { animated: false, frames: 1, fps: 0, duration: 0, width: Math.round(CANVAS.w * scale), height: Math.round(CANVAS.h * scale) };
  }
  let useFps = fps > 0 ? fps : t.nativeFps || 20;
  const outDuration = t.duration / speed;
  let frames = Math.max(1, Math.round((outDuration * useFps) / 1000));
  let capped = false;
  if (frames > LIMITS.maxExportFrames) {
    // 뒷부분을 잘라내면 반복 재생이 끊겨 보인다. 길이는 지키고 fps 를 낮춘다.
    frames = LIMITS.maxExportFrames;
    useFps = Math.max(1, Math.round((frames * 1000) / outDuration));
    capped = true;
  }
  return {
    animated: true,
    frames,
    fps: useFps,
    capped,
    duration: outDuration,
    width: Math.round(CANVAS.w * scale),
    height: Math.round(CANVAS.h * scale),
  };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function canvasToBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

/* ---------- PNG ---------- */

export async function exportPng(state, overlay, { scale = 1 } = {}) {
  const w = Math.round(CANVAS.w * scale);
  const h = Math.round(CANVAS.h * scale);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  drawScene(ctx, { state, time: 0, scale, overlay });
  const blob = await canvasToBlob(canvas, 'image/png');
  download(blob, `텐카_${stamp()}.png`);
  return { size: blob.size };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * 보관함 목록에 쓸 작은 미리보기.
 *
 * blobs 저장소가 아니라 문자열(dataURL)로 돌려주는 이유가 있다. blobs 는
 * keepOnly() 로 정리되는데, 거기에 썸네일을 넣으면 '어느 작업물도 사진으로
 * 참조하지 않는 키'라 정리 때 지워진다. 문서 레코드 안에 값으로 들고 있으면
 * 그 함정에 걸리지 않는다.
 *
 * 배경이 흰색이라 투명도가 필요 없으므로 JPEG 로 뽑는다 — PNG 보다 훨씬 작다.
 */
export async function renderThumb(state, overlay, width = 200) {
  const scale = width / CANVAS.w;
  const canvas = makeCanvas(Math.round(CANVAS.w * scale), Math.round(CANVAS.h * scale));
  drawScene(canvas.getContext('2d'), { state, time: 0, scale, overlay });
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.72);
  return blobToDataUrl(blob);
}

/** 클립보드에 그림을 넣을 수 있는 브라우저인가. */
export function canCopyImage() {
  return typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
}

async function renderPngBlob(state, overlay, scale) {
  const canvas = makeCanvas(Math.round(CANVAS.w * scale), Math.round(CANVAS.h * scale));
  drawScene(canvas.getContext('2d'), { state, time: 0, scale, overlay });
  return canvasToBlob(canvas, 'image/png');
}

/**
 * PNG 를 클립보드에 넣는다. 저장 → 파일 찾기 → 첨부 세 단계가 붙여넣기 한 번이 된다.
 *
 * 클립보드 규격이 사실상 PNG 만 받으므로 GIF·영상은 지원할 수 없다.
 * 사파리는 사용자 조작이 끝난 뒤에 만들어진 Blob 을 거부하므로, 렌더가 끝나기 전에
 * 약속(Promise)째로 넘기는 방식을 먼저 쓰고 실패하면 완성된 Blob 으로 다시 시도한다.
 */
export async function copyPng(state, overlay, { scale = 1 } = {}) {
  if (!canCopyImage()) throw new Error('이 브라우저는 그림 복사를 지원하지 않습니다.');
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': renderPngBlob(state, overlay, scale) }),
    ]);
  } catch {
    const blob = await renderPngBlob(state, overlay, scale);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }
  return { ok: true };
}

/* ---------- 팔레트 표본 (내보내기와 용량 추정이 공유) ---------- */

/**
 * 고르게 뽑은 몇 장에서만 색을 모은다. 축소 렌더라 메모리가 가볍다.
 * @returns {Promise<Uint8Array|null>} 취소되면 null
 */
async function collectSamples(state, overlay, plan, sceneTime, onProgress, isCancelled) {
  const probeCount = Math.min(plan.frames, 14);
  const probeScale = Math.min(1, 512 / CANVAS.w);
  const pw = Math.round(CANVAS.w * probeScale);
  const ph = Math.round(CANVAS.h * probeScale);
  const ctx = makeCanvas(pw, ph).getContext('2d', { willReadFrequently: true });
  const probes = [];
  for (let i = 0; i < probeCount; i++) {
    const idx = Math.floor((i * plan.frames) / probeCount);
    drawScene(ctx, { state, time: sceneTime(idx), scale: probeScale, overlay });
    probes.push(ctx.getImageData(0, 0, pw, ph).data);
    onProgress?.({ phase: 'palette', ratio: (i + 1) / probeCount });
    if (isCancelled?.()) return null;
    await tick();
  }
  const samples = sampleColors(probes, 120000);
  probes.length = 0;
  return samples;
}

/* ---------- 용량 추정 ---------- */

/** PNG 는 한 장이므로 실제로 만들어 정확한 크기를 잰다. */
export async function measurePng(state, overlay, { scale = 1 } = {}) {
  const w = Math.round(CANVAS.w * scale);
  const h = Math.round(CANVAS.h * scale);
  const ctx = makeCanvas(w, h).getContext('2d');
  drawScene(ctx, { state, time: 0, scale, overlay });
  const blob = await canvasToBlob(ctx.canvas, 'image/png');
  return blob.size;
}

/**
 * 출력 프레임 중 실제로 기록되는 장수를 렌더링 없이 센다.
 *
 * 출력 fps 와 원본 fps 가 다르면 연속 두 프레임이 같은 원본 프레임을 가리키는 일이
 * 생기고, 그런 프레임은 인코더가 병합해 버려 용량을 차지하지 않는다.
 * 이걸 빼지 않으면 용량이 10% 넘게 과대 추정된다.
 */
function countWrittenFrames(state, plan, sceneTime) {
  const assets = Object.keys(state.slots)
    .map((k) => getAsset(state.slots[k]?.asset))
    .filter((a) => a && a.frames.length > 1);
  if (!assets.length) return 1;

  const sigAt = (i) => assets.map((a) => frameIndexAt(a, sceneTime(i))).join(',');
  let written = 1;
  let prev = sigAt(0);
  for (let i = 1; i < plan.frames; i++) {
    const cur = sigAt(i);
    if (cur !== prev) written++;
    prev = cur;
  }
  return written;
}

/**
 * 색 수별 GIF 예상 용량을 잰다.
 *
 * 키프레임 비용은 첫 프레임에서, 차분 비용은 타임라인 여러 지점에서 '연속된 두 장'을
 * 인코딩해 잰다. 띄엄띄엄 뽑으면 프레임 간 차이가 실제보다 커져 과대 추정되므로
 * 반드시 이웃한 쌍이어야 하고, 한 구간만 보면 그 구간 특성에 치우치므로 여러 곳에서 뽑는다.
 *
 * @returns {Promise<{plan:object, rows:Array<{colors:number, bytes:number}>}|null>}
 */
export async function estimateGifSizes(state, overlay, o) {
  const { scale = 1, fps, speed = 1, colorOptions = [64, 128, 255], onProgress, isCancelled } = o;
  const plan = planExport(state, { fps, speed, scale });
  if (!plan.animated) return null;

  const w = plan.width, h = plan.height;
  const ctx = makeCanvas(w, h).getContext('2d', { willReadFrequently: true });
  const frameDelay = 1000 / plan.fps;
  const sceneTime = (i) => i * frameDelay * speed;

  const samples = await collectSamples(state, overlay, plan, sceneTime,
    (p) => onProgress?.({ phase: 'palette', ratio: p.ratio * 0.3 }), isCancelled);
  if (!samples) return null;

  const written = countWrittenFrames(state, plan, sceneTime);

  // 표본 지점: 타임라인을 고르게 나눈 위치에서 연속 두 장씩
  const points = scale >= 1.5 ? [0.25, 0.6] : [0.2, 0.45, 0.75];
  const need = [0];
  for (const t of points) {
    const j = Math.min(plan.frames - 2, Math.max(0, Math.floor(t * plan.frames)));
    if (plan.frames >= 2) need.push(j, j + 1);
  }
  const uniq = [...new Set(need)];

  const shots = new Map();
  for (let n = 0; n < uniq.length; n++) {
    if (isCancelled?.()) return null;
    const i = uniq[n];
    drawScene(ctx, { state, time: sceneTime(i), scale, overlay });
    shots.set(i, ctx.getImageData(0, 0, w, h).data);
    onProgress?.({ phase: 'measure', ratio: 0.3 + ((n + 1) / uniq.length) * 0.25 });
    await tick();
  }

  const rows = [];
  for (let c = 0; c < colorOptions.length; c++) {
    if (isCancelled?.()) { shots.clear(); return null; }
    const colors = colorOptions[c];
    const palette = buildPalette(samples, colors);

    // 키프레임 비용 (헤더·팔레트 포함)
    const head = new GifStream({ width: w, height: h, palette, diff: true });
    head.addRGBA(shots.get(0), frameDelay);
    const keyBytes = head.byteLength;

    // 차분 비용
    let diffTotal = 0, diffCount = 0;
    for (const t of points) {
      const j = Math.min(plan.frames - 2, Math.max(0, Math.floor(t * plan.frames)));
      if (plan.frames < 2 || !shots.has(j) || !shots.has(j + 1)) continue;
      const e = new GifStream({ width: w, height: h, palette, diff: true });
      e.addRGBA(shots.get(j), frameDelay);
      const before = e.byteLength;
      if (e.addRGBA(shots.get(j + 1), frameDelay)) {
        diffTotal += e.byteLength - before;
        diffCount++;
      }
    }
    const perDiff = diffCount ? diffTotal / diffCount : 0;
    rows.push({ colors, bytes: Math.round(keyBytes + perDiff * Math.max(0, written - 1) + 1) });

    onProgress?.({ phase: 'measure', ratio: 0.55 + ((c + 1) / colorOptions.length) * 0.45 });
    await tick();
  }
  shots.clear();
  return { plan, rows };
}

/* ---------- GIF ---------- */

/**
 * @param {object} o
 * @param {(p:{phase:string, ratio:number, detail?:string})=>void} o.onProgress
 * @param {()=>boolean} o.isCancelled
 */
export async function exportGif(state, overlay, o) {
  const { scale = 1, fps, speed = 1, colors = 255, onProgress, isCancelled } = o;
  const plan = planExport(state, { fps, speed, scale });
  const w = plan.width, h = plan.height;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const frameDelay = 1000 / plan.fps;
  const sceneTime = (i) => i * frameDelay * speed;

  // 1) 팔레트용 표본
  const samples = await collectSamples(state, overlay, plan, sceneTime, onProgress, isCancelled);
  if (!samples) return null;

  let palette;
  const useWorker = workerAvailable();
  if (useWorker) {
    try {
      const r = await workerCall('palette', { samples, maxColors: colors });
      palette = new Uint8Array(r.palette);
    } catch { palette = buildPalette(samples, colors); }
  } else {
    palette = buildPalette(samples, colors);
  }
  if (isCancelled?.()) return null;

  // 2) 프레임을 하나씩 그려 곧바로 인코더로 넘긴다.
  const session = `s${Date.now()}`;
  let local = null;
  if (useWorker) {
    try {
      await workerCall('gifInit', { session, width: w, height: h, palette, diff: true });
    } catch { local = new GifStream({ width: w, height: h, palette, diff: true }); }
  } else {
    local = new GifStream({ width: w, height: h, palette, diff: true });
  }

  let bytesSoFar = 0;
  for (let i = 0; i < plan.frames; i++) {
    if (isCancelled?.()) {
      if (!local) await workerCall('gifAbort', { session }).catch(() => {});
      return null;
    }
    drawScene(ctx, { state, time: sceneTime(i), scale, overlay });
    const img = ctx.getImageData(0, 0, w, h);
    if (local) {
      local.addRGBA(img.data, frameDelay);
      bytesSoFar = local.byteLength;
    } else {
      const r = await workerCall('gifFrame', { session, rgba: img.data.buffer, delay: frameDelay }, [img.data.buffer]);
      bytesSoFar = r.bytes;
    }
    onProgress?.({
      phase: 'encode',
      ratio: (i + 1) / plan.frames,
      detail: `${i + 1} / ${plan.frames} 프레임 · ${formatBytes(bytesSoFar)}`,
    });
    await tick();
  }

  const bytes = local ? local.finish() : new Uint8Array((await workerCall('gifFinish', { session })).bytes);
  const blob = new Blob([bytes], { type: 'image/gif' });
  download(blob, `텐카_${stamp()}.gif`);
  return { size: blob.size, frames: plan.frames };
}

/* ---------- 영상 (WebM 또는 MP4) ---------- */

export function videoSupport() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    { mime: 'video/webm;codecs=vp9', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
    { mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.mime)) || null;
}

/**
 * MediaRecorder 로 녹화한다. 프레임은 수동(requestFrame)으로 넣되
 * 실제 시간에 맞춰 넣어야 재생 속도가 맞으므로, 녹화는 재생 길이만큼 걸린다.
 */
export async function exportVideo(state, overlay, o) {
  const support = videoSupport();
  if (!support) throw new Error('이 브라우저는 영상 녹화를 지원하지 않습니다.');

  const { scale = 1, fps, speed = 1, onProgress, isCancelled } = o;
  const plan = planExport(state, { fps, speed, scale });
  if (!plan.animated) throw new Error('움직이는 사진이 없어 영상으로 만들 수 없습니다.');

  const w = plan.width, h = plan.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const recorder = new MediaRecorder(stream, {
    mimeType: support.mime,
    videoBitsPerSecond: Math.round(w * h * plan.fps * 0.12),
  });

  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { recorder.onstop = res; });
  recorder.start();

  const frameDelay = 1000 / plan.fps;
  const t0 = performance.now();

  for (let i = 0; i < plan.frames; i++) {
    if (isCancelled?.()) { recorder.stop(); await done; return null; }
    drawScene(ctx, { state, time: i * frameDelay * speed, scale, overlay });
    track.requestFrame?.();
    onProgress?.({ phase: 'record', ratio: (i + 1) / plan.frames, detail: `${i + 1} / ${plan.frames} 프레임 녹화 중` });
    const target = t0 + (i + 1) * frameDelay;
    const wait = target - performance.now();
    await sleep(Math.max(0, wait));
  }

  await sleep(120);
  recorder.stop();
  await done;

  const blob = new Blob(chunks, { type: support.mime });
  download(blob, `텐카_${stamp()}.${support.ext}`);
  return { size: blob.size, frames: plan.frames, ext: support.ext };
}

/* ---------- 유틸 ---------- */

function tick() {
  // rAF 를 globalThis 에서 떼어내 호출하면 일부 브라우저가 Illegal invocation 을 던진다.
  return new Promise((r) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
    else setTimeout(r, 0);
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
