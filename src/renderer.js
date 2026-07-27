// 장면 렌더러.
// 프리뷰와 내보내기가 이 함수 하나를 공유한다 —
// "미리보기랑 결과물이 다르다"는 문제가 구조적으로 생길 수 없게 하려는 것.

import { CANVAS, SLOTS, SLOT_MAP, TEXTS, TEXT_MAP, LIMITS } from './config.js';
import { getAsset, frameAt, frameIndexAt } from './assets.js';
import { drawText, fitSize, wrap } from './text.js';
import { visibleRect, holesReady } from './mask.js';

/** 가려지는 부분을 비춰 주는 정도. */
const GHOST_ALPHA = 0.26;

/* ---------- 로고 외곽선 캐시 ---------- */

const outlineCache = new Map();
const OUTLINE_CACHE_MAX = 64;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/* ---------- 합성용 임시 캔버스 ---------- */

// 미리보기 보조선은 매 프레임 그려지므로 캔버스를 새로 만들면 GC 가 요동친다.
// 가장 큰 요구 크기에 맞춰 하나만 두고 돌려 쓴다.
let scratchCanvas = null;

function scratch(w, h) {
  if (!scratchCanvas) scratchCanvas = makeCanvas(w, h);
  if (scratchCanvas.width < w || scratchCanvas.height < h) {
    scratchCanvas.width = Math.max(scratchCanvas.width, w);
    scratchCanvas.height = Math.max(scratchCanvas.height, h);
  }
  const c = scratchCanvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
  return c;
}

/**
 * 이미지 둘레에 균일한 외곽선을 두른 캔버스를 만든다.
 * 원본 에디터는 상하좌우 4방향 drop-shadow를 썼는데 그러면 대각선 모서리가 파인다.
 * 여기서는 실루엣을 원형으로 스탬핑해서 어느 방향이든 두께가 같게 한다.
 */
function buildOutlined(bitmap, width, color) {
  const pad = Math.ceil(width) + 2;
  const w = bitmap.width + pad * 2;
  const h = bitmap.height + pad * 2;

  const sil = makeCanvas(w, h);
  const sctx = sil.getContext('2d');
  sctx.drawImage(bitmap, pad, pad);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = color;
  sctx.fillRect(0, 0, w, h);

  const out = makeCanvas(w, h);
  const octx = out.getContext('2d');
  const steps = Math.min(24, Math.max(8, Math.ceil(width * 2.5)));
  const rings = width > 6 ? 2 : 1;
  for (let r = 1; r <= rings; r++) {
    const rad = (width * r) / rings;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      octx.drawImage(sil, Math.cos(a) * rad, Math.sin(a) * rad);
    }
  }
  octx.drawImage(bitmap, pad, pad);
  return { canvas: out, pad };
}

function outlinedFor(assetId, frameIndex, bitmap, width, color) {
  const key = `${assetId}|${frameIndex}|${width}|${color}`;
  const hit = outlineCache.get(key);
  if (hit) {
    outlineCache.delete(key);
    outlineCache.set(key, hit); // LRU 갱신
    return hit;
  }
  const built = buildOutlined(bitmap, width, color);
  outlineCache.set(key, built);
  if (outlineCache.size > OUTLINE_CACHE_MAX) {
    outlineCache.delete(outlineCache.keys().next().value);
  }
  return built;
}

export function clearOutlineCache() {
  outlineCache.clear();
}

/* ---------- 배치 계산 ---------- */

/** 슬롯 안 사진의 화면상 사각형(회전 전, 중심 기준). */
export function placementBox(slotKey, placement) {
  const asset = getAsset(placement?.asset);
  if (!asset) return null;
  const w = asset.width * placement.scale;
  const h = asset.height * placement.scale;
  return { cx: placement.x, cy: placement.y, w, h, angle: placement.angle || 0 };
}

/** 텍스트 상자의 현재 위치(이동 오프셋·폭 반영). */
export function textBox(key, ts) {
  const base = TEXT_MAP[key].box;
  return {
    x: base.x + (ts.dx || 0),
    y: base.y + (ts.dy || 0),
    w: ts.w || base.w,
    h: base.h,
  };
}

/** 자동 맞춤이 켜져 있으면 계산된 크기를, 아니면 지정 크기를 준다. */
export function effectiveSize(ctx, key, state) {
  const ts = state.texts[key];
  if (!ts.auto) return ts.size;
  return fitSize(ctx, ts.text, state.font, textBox(key, ts), LIMITS.minFontSize, LIMITS.maxFontSize);
}

/* ---------- 본체 ---------- */

function drawSlot(ctx, slotKey, state, time) {
  const p = state.slots[slotKey];
  const asset = getAsset(p?.asset);
  if (!asset) return;
  const bitmap = frameAt(asset, time);
  if (!bitmap) return;

  const rect = SLOT_MAP[slotKey].rect;
  const w = asset.width * p.scale;
  const h = asset.height * p.scale;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.translate(p.x, p.y);
  if (p.angle) ctx.rotate((p.angle * Math.PI) / 180);
  if (p.flip) ctx.scale(-1, 1);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawLogo(ctx, state, time, scale) {
  const p = state.slots.logo;
  const asset = getAsset(p?.asset);
  if (!asset) return;
  const frameIndex = frameIndexAt(asset, time);
  const bitmap = asset.frames[frameIndex];
  if (!bitmap) return;

  const { outline, shadow } = state.effects;
  const rect = SLOT_MAP.logo.rect;

  let src = bitmap;
  let pad = 0;
  if (outline.on && outline.width > 0) {
    const built = outlinedFor(p.asset, frameIndex, bitmap, outline.width, outline.color);
    src = built.canvas;
    pad = built.pad;
  }

  const w = asset.width * p.scale;
  const h = asset.height * p.scale;
  const dw = w + pad * 2 * p.scale;
  const dh = h + pad * 2 * p.scale;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  if (shadow.on) {
    // 그림자 오프셋/블러는 변환 행렬의 영향을 받지 않으므로 직접 배율을 곱한다.
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur * scale;
    ctx.shadowOffsetX = shadow.dx * scale;
    ctx.shadowOffsetY = shadow.dy * scale;
  }

  ctx.translate(p.x, p.y);
  if (p.angle) ctx.rotate((p.angle * Math.PI) / 180);
  if (p.flip) ctx.scale(-1, 1);
  ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

/**
 * 선택된 사진에서 '보이지 않게 되는 부분'을 옅게 비춰 준다.
 * 이게 없으면 사진을 옮길 때 무엇이 잘리는지 모르는 채로 감으로 맞춰야 한다.
 *
 * 가려지는 경로는 둘이고, 넓이로 보면 두 번째가 훨씬 크다.
 *   (1) 칸 사각형 바깥 — clip 에 잘린다
 *   (2) 칸 안이지만 템플릿 그림에 덮인다 — 말풍선은 칸의 65% 가 여기 해당한다
 *
 * (2)는 overlay 이미지를 그대로 destination-in 마스크로 쓴다. 알파를 있는 그대로
 * 쓰므로 구멍의 안티에일리어싱된 가장자리까지 정확히 일치하고, 배율을 올려도
 * 실제로 그려지는 overlay 와 같은 보간을 거치므로 경계가 어긋나지 않는다.
 * 사각형으로 근사하지 않는 이유가 이것이다.
 */
function drawCropGhost(ctx, slotKey, state, time, scale, overlay) {
  const p = state.slots[slotKey];
  const asset = getAsset(p?.asset);
  if (!asset) return;
  const bitmap = frameAt(asset, time);
  if (!bitmap) return;

  const slot = SLOT_MAP[slotKey];
  const rect = slot.rect;
  const w = asset.width * p.scale;
  const h = asset.height * p.scale;

  // 사진을 제자리에 놓는 변환. 본 렌더(drawSlot)와 반드시 같아야 한다.
  const place = (c) => {
    c.translate(p.x, p.y);
    if (p.angle) c.rotate((p.angle * Math.PI) / 180);
    if (p.flip) c.scale(-1, 1);
    c.drawImage(bitmap, -w / 2, -h / 2, w, h);
  };

  // (1) 칸 사각형 바깥
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, CANVAS.w, CANVAS.h);
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip('evenodd');
  ctx.globalAlpha = GHOST_ALPHA;
  place(ctx);
  ctx.restore();

  // (2) 칸 안에서 템플릿 그림에 덮이는 부분
  if (overlay && !slot.above && overlay.complete && overlay.naturalWidth) {
    const dw = Math.max(1, Math.ceil(rect.w * scale));
    const dh = Math.max(1, Math.ceil(rect.h * scale));
    const g = scratch(dw, dh);

    g.setTransform(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale);
    place(g);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(overlay, -rect.x * scale, -rect.y * scale, CANVAS.w * scale, CANVAS.h * scale);

    ctx.save();
    ctx.globalAlpha = GHOST_ALPHA;
    ctx.drawImage(g.canvas, 0, 0, dw, dh, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }

  // 로고는 그림 위에 얹히므로 사각형이 곧 경계다. 나머지 칸은 사각형이 구멍보다
  // 한참 넓어서 선을 그으면 오히려 거짓말이 된다 — 짙게 보이는 부분이 곧 경계다.
  if (slot.above) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(70, 216, 232, 0.9)';
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    ctx.restore();
  }
}

/** 문구가 칸을 넘쳤을 때 표시하는 테두리. */
function drawOverflowMark(ctx, box) {
  ctx.save();
  ctx.setLineDash([7, 5]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 122, 92, 0.95)';
  ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
  ctx.restore();
}

/**
 * 빈 칸 안내. 채움은 실제로 뚫린 모양대로, 테두리와 글자는 그 구멍의 범위에 맞춘다.
 * 사각형 그대로 칠하면 사진이 들어갈 자리를 실제보다 두 배 넓게 알려주게 된다.
 */
function drawPlaceholders(ctx, state, hovered, scale, overlay) {
  const useHoles = overlay && overlay.complete && overlay.naturalWidth && holesReady();

  for (const slot of SLOTS) {
    if (state.slots[slot.key]) continue;
    const r = slot.rect;
    const vis = useHoles ? visibleRect(slot.key) : r;
    const active = hovered === slot.key;
    const fill = active ? 'rgba(70,216,232,0.16)' : 'rgba(240,242,248,0.62)';

    ctx.save();

    if (useHoles && !slot.above) {
      // 구멍 모양만 칠한다 — overlay 알파를 빼내는 방식이라 모양이 정확하다.
      const dw = Math.max(1, Math.ceil(r.w * scale));
      const dh = Math.max(1, Math.ceil(r.h * scale));
      const g = scratch(dw, dh);
      g.fillStyle = fill;
      g.fillRect(0, 0, dw, dh);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(overlay, -r.x * scale, -r.y * scale, CANVAS.w * scale, CANVAS.h * scale);
      ctx.drawImage(g.canvas, 0, 0, dw, dh, r.x, r.y, r.w, r.h);
    } else {
      ctx.fillStyle = fill;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }

    ctx.setLineDash([9, 7]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = active ? 'rgba(70,216,232,0.95)' : 'rgba(120,130,150,0.55)';
    ctx.strokeRect(vis.x + 1, vis.y + 1, vis.w - 2, vis.h - 2);

    ctx.setLineDash([]);
    ctx.fillStyle = active ? '#1a7f8c' : '#7c8496';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const big = vis.w > 160 && vis.h > 90;
    ctx.font = `600 ${big ? 17 : 12}px Pretendard, system-ui, sans-serif`;
    ctx.fillText(slot.label, vis.x + vis.w / 2, vis.y + vis.h / 2 - (big ? 10 : 0));
    if (big) {
      ctx.font = '400 13px Pretendard, system-ui, sans-serif';
      ctx.fillText('클릭하거나 사진을 끌어다 놓기', vis.x + vis.w / 2, vis.y + vis.h / 2 + 14);
    }
    ctx.restore();
  }
}

/**
 * 한 프레임을 그린다.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o
 * @param {object} o.state
 * @param {number} o.time      장면 시각(ms)
 * @param {number} [o.scale=1] 출력 배율
 * @param {HTMLImageElement} [o.overlay] 템플릿 그림
 * @param {number} [o.dim=0]   템플릿을 흐리게 하는 정도 (사진 배치 중 0.7)
 * @param {boolean} [o.editing] 편집 중인 텍스트 키 (캔버스에서는 숨김)
 * @param {boolean} [o.preview] 플레이스홀더/보조선 표시 여부
 * @param {string} [o.hovered]
 */
export function drawScene(ctx, o) {
  const { state, time = 0, scale = 1, overlay, dim = 0, preview = false, hovered = null, editingText = null, selected = null } = o;

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, CANVAS.w, CANVAS.h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS.w, CANVAS.h);

  if (preview) drawPlaceholders(ctx, state, hovered, scale, overlay);

  drawSlot(ctx, 'bubble', state, time);
  drawSlot(ctx, 'phone', state, time);

  if (overlay && overlay.complete && overlay.naturalWidth) {
    ctx.save();
    ctx.globalAlpha = 1 - dim * 0.72;
    ctx.drawImage(overlay, 0, 0, CANVAS.w, CANVAS.h);
    ctx.restore();
  }

  drawLogo(ctx, state, time, scale);

  ctx.save();
  ctx.globalAlpha = 1 - dim * 0.85;
  const overflowed = [];
  for (const t of TEXTS) {
    if (editingText === t.key) continue;
    const ts = state.texts[t.key];
    if (!ts.text) continue;
    const box = textBox(t.key, ts);
    const size = ts.auto
      ? fitSize(ctx, ts.text, state.font, box, LIMITS.minFontSize, LIMITS.maxFontSize)
      : ts.size;
    const m = drawText(ctx, ts.text, size, state.font, box, ts.color || '#000000');
    if (preview && m.height > box.h + 1) overflowed.push(box);
  }
  ctx.restore();

  if (preview) {
    for (const box of overflowed) drawOverflowMark(ctx, box);
    if (selected?.type === 'slot') drawCropGhost(ctx, selected.key, state, time, scale, overlay);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** 텍스트가 상자를 넘치는지 (경고 표시용) */
export function textOverflows(ctx, key, state) {
  const ts = state.texts[key];
  if (ts.auto) return false;
  const box = textBox(key, ts);
  const m = wrap(ctx, ts.text, ts.size, state.font, box.w);
  return m.height > box.h + 1;
}
