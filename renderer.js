// 장면 렌더러.
// 프리뷰와 내보내기가 이 함수 하나를 공유한다 —
// "미리보기랑 결과물이 다르다"는 문제가 구조적으로 생길 수 없게 하려는 것.

import { CANVAS, SLOTS, SLOT_MAP, TEXTS, TEXT_MAP, LIMITS } from './config.js';
import { getAsset, frameAt, frameIndexAt } from './assets.js';
import { drawText, fitSize, wrap } from './text.js';

/* ---------- 로고 외곽선 캐시 ---------- */

const outlineCache = new Map();
const OUTLINE_CACHE_MAX = 64;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
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

function drawPlaceholders(ctx, state, hovered) {
  for (const slot of SLOTS) {
    if (state.slots[slot.key]) continue;
    const r = slot.rect;
    ctx.save();
    ctx.setLineDash([9, 7]);
    ctx.lineWidth = 2;
    const active = hovered === slot.key;
    ctx.strokeStyle = active ? 'rgba(70,216,232,0.95)' : 'rgba(120,130,150,0.55)';
    ctx.fillStyle = active ? 'rgba(70,216,232,0.10)' : 'rgba(240,242,248,0.55)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    ctx.setLineDash([]);
    ctx.fillStyle = active ? '#1a7f8c' : '#7c8496';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const big = r.w > 160 && r.h > 90;
    ctx.font = `600 ${big ? 17 : 12}px Pretendard, system-ui, sans-serif`;
    ctx.fillText(slot.label, r.x + r.w / 2, r.y + r.h / 2 - (big ? 10 : 0));
    if (big) {
      ctx.font = '400 13px Pretendard, system-ui, sans-serif';
      ctx.fillText('클릭하거나 사진을 끌어다 놓기', r.x + r.w / 2, r.y + r.h / 2 + 14);
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
  const { state, time = 0, scale = 1, overlay, dim = 0, preview = false, hovered = null, editingText = null } = o;

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, CANVAS.w, CANVAS.h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS.w, CANVAS.h);

  if (preview) drawPlaceholders(ctx, state, hovered);

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
  for (const t of TEXTS) {
    if (editingText === t.key) continue;
    const ts = state.texts[t.key];
    if (!ts.text) continue;
    const box = textBox(t.key, ts);
    const size = ts.auto
      ? fitSize(ctx, ts.text, state.font, box, LIMITS.minFontSize, LIMITS.maxFontSize)
      : ts.size;
    drawText(ctx, ts.text, size, state.font, box, ts.color || '#000000');
  }
  ctx.restore();

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
