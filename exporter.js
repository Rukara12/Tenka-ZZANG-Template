// 내보내기.
// 프레임 시각을 프리뷰와 똑같이 계산하므로 "미리보기와 결과물이 다른" 문제가 없다.

import { CANVAS, LIMITS } from './config.js';
import { getAsset, workerCall, workerAvailable } from './assets.js';
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

  // 1) 팔레트용 표본 — 전체를 두 번 그리지 않고 고르게 뽑은 몇 장에서만 색을 모은다.
  const probeCount = Math.min(plan.frames, 14);
  const probeScale = Math.min(scale, 512 / CANVAS.w);
  const pw = Math.round(CANVAS.w * probeScale);
  const ph = Math.round(CANVAS.h * probeScale);
  const probeCanvas = makeCanvas(pw, ph);
  const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
  const probes = [];
  for (let i = 0; i < probeCount; i++) {
    const idx = Math.floor((i * plan.frames) / probeCount);
    drawScene(probeCtx, { state, time: sceneTime(idx), scale: probeScale, overlay });
    probes.push(probeCtx.getImageData(0, 0, pw, ph).data);
    onProgress?.({ phase: 'palette', ratio: (i + 1) / probeCount });
    if (isCancelled?.()) return null;
    await tick();
  }
  const samples = sampleColors(probes, 120000);
  probes.length = 0;

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
