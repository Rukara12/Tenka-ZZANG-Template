// 장면 렌더러.
// 프리뷰와 내보내기가 이 함수 하나를 공유한다 —
// "미리보기랑 결과물이 다르다"는 문제가 구조적으로 생길 수 없게 하려는 것.

import {
  CANVAS, SLOTS, SLOT_MAP, TEXTS, TEXT_MAP, LIMITS, MIN_TEXT_BOX, guideBandRect,
} from './config.js';
import { getAsset, frameAt, frameIndexAt } from './assets.js';
import { drawText, fitSize, wrap, fontSpec } from './text.js';
import {
  visibleRect, labelPoint, holesReady, insideBubble, bubblesReady, bubbleAnchor,
} from './mask.js';

/** 가려지는 부분을 비춰 주는 정도. */
const GHOST_ALPHA = 0.26;

/**
 * 칸을 하나 고르고 있을 때, 고르지 않은 칸의 사진을 흐리게 하는 정도.
 * 셋 다 또렷하면 지금 만지는 게 어느 것인지 눈으로 구분되지 않는다.
 */
const UNFOCUSED_ALPHA = 0.3;

/* 문구가 말풍선을 벗어났는지 재는 표본. 글자는 줄 간격의 17~95% 구간에 놓인다. */
const SAMPLES_X = 9;
const SAMPLES_Y = 3;
const GLYPH_TOP = 0.17;
const GLYPH_SPAN = 0.78;
/** 표본의 이 비율까지는 봐준다. 글자 모서리가 몇 픽셀 스치는 것까지 경고하면 시끄럽다. */
const ESCAPE_TOLERANCE = 0.05;

/** 이보다 작아지면 '맞춘' 게 아니라 그냥 안 보이는 것이다 — 상자 쪽을 손봐야 한다. */
const READABLE_SIZE = 14;

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
    h: ts.h || base.h,
  };
}

/** 자동 맞춤이 켜져 있으면 계산된 크기를, 아니면 지정 크기를 준다. */
export function effectiveSize(ctx, key, state) {
  const ts = state.texts[key];
  if (!ts.auto) return ts.size;
  return fitTextSize(ctx, key, state);
}

/* ---------- 본체 ---------- */

function drawSlot(ctx, slotKey, state, time, alpha = 1) {
  const p = state.slots[slotKey];
  const asset = getAsset(p?.asset);
  if (!asset) return;
  const bitmap = frameAt(asset, time);
  if (!bitmap) return;

  const rect = SLOT_MAP[slotKey].rect;
  const w = asset.width * p.scale;
  const h = asset.height * p.scale;

  ctx.save();
  if (alpha < 1) ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.translate(p.x, p.y);
  if (p.angle) ctx.rotate((p.angle * Math.PI) / 180);
  if (p.flip) ctx.scale(-1, 1);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawLogo(ctx, state, time, scale, alpha = 1) {
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
  if (alpha < 1) ctx.globalAlpha = alpha;
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
 *
 * 안내는 그 칸의 사진이 놓일 층에 그려야 한다. above 칸(로고)을 템플릿 그림보다
 * 아래에 그리면 그림이 불투명해서 안내가 통째로 가려진다 — 그래서 층별로 나눠 부른다.
 *
 * @param {boolean} above 이번에 그릴 층 (false=그림 아래, true=그림 위)
 */
function drawPlaceholders(ctx, state, hovered, scale, overlay, above) {
  const useHoles = overlay && overlay.complete && overlay.naturalWidth && holesReady();

  for (const slot of SLOTS) {
    if (!!slot.above !== above) continue;
    if (state.slots[slot.key]) continue;
    const r = slot.rect;
    const vis = useHoles ? visibleRect(slot.key) : r;
    const active = hovered === slot.key;
    // above 칸은 흰 구멍이 아니라 그림 위에 얹히므로, 같은 농도로는 글자가 묻힌다.
    const fill = active
      ? (slot.above ? 'rgba(70,216,232,0.30)' : 'rgba(70,216,232,0.16)')
      : (slot.above ? 'rgba(242,244,249,0.82)' : 'rgba(240,242,248,0.62)');

    // above 칸은 마스킹 영역이 사각형 전체지만, 그걸 다 덮으면 그림이 가려져 답답하다.
    // 안내는 좌하단에 낮은 띠로만 두고, 누를 수 있는 범위는 사각형 전체로 그대로 둔다.
    const band = slot.above ? guideBandRect(slot.key) : null;

    ctx.save();

    if (band) {
      ctx.fillStyle = fill;
      ctx.fillRect(band.x, band.y, band.w, band.h);
      ctx.setLineDash([9, 7]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? 'rgba(70,216,232,0.95)' : 'rgba(120,130,150,0.7)';
      ctx.strokeRect(band.x + 1, band.y + 1, band.w - 2, band.h - 2);
      ctx.setLineDash([]);

      const cx = band.x + band.w / 2;
      const cy = band.y + band.h / 2;
      ctx.fillStyle = active ? '#1a7f8c' : '#5d6676';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 14px Pretendard, system-ui, sans-serif';
      ctx.fillText(slot.label, cx, cy - 8);
      ctx.font = '400 11.5px Pretendard, system-ui, sans-serif';
      ctx.fillText('클릭 · 사진을 끌어다 놓기', cx, cy + 9);

      ctx.restore();
      continue;
    }

    if (useHoles && !slot.above) {
      // 구멍 모양만 칠한다 — overlay 알파를 빼내는 방식이라 모양이 정확하다.
      // 여기에 사각 점선까지 두르면 칠한 모양과 어긋나 눈에 거슬리므로 두르지 않는다.
      // 어디를 누르면 되는지는 칠해진 면과 hover 색으로 충분히 읽힌다.
      const dw = Math.max(1, Math.ceil(r.w * scale));
      const dh = Math.max(1, Math.ceil(r.h * scale));
      const g = scratch(dw, dh);
      g.fillStyle = fill;
      g.fillRect(0, 0, dw, dh);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(overlay, -r.x * scale, -r.y * scale, CANVAS.w * scale, CANVAS.h * scale);
      ctx.drawImage(g.canvas, 0, 0, dw, dh, r.x, r.y, r.w, r.h);
    } else {
      // 로고처럼 구멍이 없는 칸은 사각형이 곧 영역이라 점선을 두르는 게 맞다.
      ctx.fillStyle = fill;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([9, 7]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? 'rgba(70,216,232,0.95)' : 'rgba(120,130,150,0.55)';
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      ctx.setLineDash([]);
    }

    // 문구는 구멍의 무게중심에 놓는다. 외접 사각형의 중심은 말풍선 꼬리 때문에
    // 몸통보다 한참 아래로 밀린다.
    const at = useHoles ? labelPoint(slot.key) : { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    ctx.fillStyle = active ? '#1a7f8c' : (slot.above ? '#5d6676' : '#7c8496');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const big = vis.w > 160 && vis.h > 90;
    ctx.font = `600 ${big ? 17 : 12}px Pretendard, system-ui, sans-serif`;
    ctx.fillText(slot.label, at.x, at.y - (big ? 10 : 0));
    if (big) {
      ctx.font = '400 13px Pretendard, system-ui, sans-serif';
      ctx.fillText('클릭하거나 사진을 끌어다 놓기', at.x, at.y + 14);
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

  // 그림 아래 칸(말풍선·핸드폰)의 안내는 여기서. 구멍으로 비쳐 보인다.
  if (preview) drawPlaceholders(ctx, state, hovered, scale, overlay, false);

  // 칸을 고르고 있으면 그 칸의 사진만 또렷하게, 나머지는 흐리게.
  // 내보낼 때(preview=false)는 당연히 전부 그대로 나간다.
  const focus = preview && selected?.type === 'slot' ? selected.key : null;
  const alphaFor = (key) => (focus && focus !== key ? UNFOCUSED_ALPHA : 1);

  drawSlot(ctx, 'bubble', state, time, alphaFor('bubble'));
  drawSlot(ctx, 'phone', state, time, alphaFor('phone'));

  if (overlay && overlay.complete && overlay.naturalWidth) {
    ctx.save();
    ctx.globalAlpha = 1 - dim * 0.72;
    ctx.drawImage(overlay, 0, 0, CANVAS.w, CANVAS.h);
    ctx.restore();
  }

  drawLogo(ctx, state, time, scale, alphaFor('logo'));

  // 그림 위 칸(로고)의 안내는 그림을 그린 뒤에. 안 그러면 통째로 가려진다.
  if (preview) drawPlaceholders(ctx, state, hovered, scale, overlay, true);

  ctx.save();
  ctx.globalAlpha = 1 - dim * 0.85;
  const overflowed = [];
  for (const t of TEXTS) {
    if (editingText === t.key) continue;
    const ts = state.texts[t.key];
    if (!ts.text) continue;
    const box = textBox(t.key, ts);
    const size = ts.auto ? fitTextSize(ctx, t.key, state) : ts.size;
    drawText(ctx, ts.text, size, state.font, box, ts.color || '#000000');
    if (preview && textOverflows(ctx, t.key, state, size)) overflowed.push(box);
  }
  ctx.restore();

  if (preview) {
    for (const box of overflowed) drawOverflowMark(ctx, box);
    if (selected?.type === 'slot') drawCropGhost(ctx, selected.key, state, time, scale, overlay);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * 문구가 말풍선 밖으로 나가는지.
 *
 * 입력 상자를 넘쳤는지는 사용자에게 아무 의미가 없다 — 상자는 편의상 그은
 * 사각형일 뿐이다. 실제로 문제가 되는 건 글자가 흰 말풍선을 벗어나 그림 위로
 * 올라타는 순간이고, 그때만 알려야 한다.
 *
 * 줄마다 실제로 그려지는 사각형을 만들어 그 둘레를 말풍선 마스크에 대본다.
 * 줄 높이에는 글자가 닿지 않는 위아래 여백이 들어 있으므로 그만큼 덜어낸다.
 */
export function textOverflows(ctx, key, state, size, strict = false) {
  const ts = state.texts[key];
  if (!ts || !ts.text.trim()) return false;

  const box = textBox(key, ts);
  const s = size ?? (ts.auto ? fitTextSize(ctx, key, state) : ts.size);

  const m = wrap(ctx, ts.text, s, state.font, box.w);
  if (!bubblesReady()) {
    // 말풍선을 못 쟀을 때만 예전 기준으로 물러난다.
    return m.height > box.h + 1;
  }

  const top = box.y + Math.max(0, (box.h - m.height) / 2);
  const cx = box.x + box.w / 2;

  ctx.font = fontSpec(s, state.font);
  let total = 0;
  let outside = 0;
  for (let i = 0; i < m.lines.length; i++) {
    const line = m.lines[i];
    if (!line.trim()) continue;
    const half = ctx.measureText(line).width / 2;
    for (let a = 0; a < SAMPLES_X; a++) {
      const px = cx - half + (2 * half * a) / (SAMPLES_X - 1);
      for (let b = 0; b < SAMPLES_Y; b++) {
        const py = top + i * m.lineHeight + m.lineHeight * (GLYPH_TOP + GLYPH_SPAN * b / (SAMPLES_Y - 1));
        total++;
        if (!insideBubble(key, px, py)) outside++;
      }
    }
  }
  return total > 0 && outside / total > (strict ? 0 : ESCAPE_TOLERANCE);
}

/**
 * 말풍선 안에 들어가는 가장 큰 글자 크기. 작을수록 안전하므로 이분 탐색이 성립한다.
 * '칸에 맞춰 자동 조절'과 '말풍선에 맞추기' 버튼이 같은 기준을 쓰게 하려는 것.
 */
export function fitTextSize(ctx, key, state) {
  const ts = state.texts[key];
  const box = textBox(key, ts);

  // 1) 상자에 들어가는 최대 크기. 이 판정은 크기에 대해 단조로워서 이분 탐색이 안전하다.
  //    상자는 말풍선 안에 들어가게 잡혀 있으므로 보통 여기서 이미 답이다.
  let size = fitSize(ctx, ts.text, state.font, box, LIMITS.minFontSize, LIMITS.maxFontSize);
  if (!bubblesReady()) return size;

  // 2) 상자를 옮겼거나 넓혀서 말풍선을 벗어난 경우에만 한 칸씩 줄인다.
  //
  //    말풍선 판정에는 이분 탐색을 쓰면 안 된다. 크기를 바꾸면 줄바꿈 위치가 바뀌고
  //    글자 덩어리가 다시 가운데 정렬되므로, '넘침/정상'이 톱니처럼 출렁여 단조롭지
  //    않다. 이분 탐색은 그 톱니의 '넘침' 지점을 밟는 순간 상한을 계속 끌어내려
  //    최소 크기까지 미끄러진다 — 맞추기 버튼이 글자를 8px 로 만들던 원인이다.
  let guard = 0;
  while (size > LIMITS.minFontSize && textOverflows(ctx, key, state, size, true)) {
    size--;
    if (++guard > LIMITS.maxFontSize) break;
  }
  return size;
}

/**
 * '말풍선에 맞추기'가 실제로 적용할 값 전부.
 *
 * 크기만 줄여서는 못 고치는 경우가 있다. 상자를 옮기거나 넓혀서 상자 자체가 말풍선
 * 밖으로 나가 있으면, 줄바꿈이 늘 상자 폭을 채우므로 글자를 아무리 줄여도 여전히
 * 벗어난다. 그때 크기만 만지면 8px 까지 미끄러지고 문제는 그대로다.
 * 그래서 크기로 안 되는 경우에만 상자를 기본 자리로 되돌린 뒤 다시 맞춘다.
 *
 * @returns {{size:number, dx:number, dy:number, w:number}}
 */
export function fitTextToBubble(ctx, key, state) {
  const def = TEXT_MAP[key].box;
  const ts = state.texts[key];
  const keep = { dx: ts.dx || 0, dy: ts.dy || 0, w: ts.w || def.w, h: ts.h || def.h };

  // 1) 글자 크기만 손봐서 읽을 만하게 되면 상자는 건드리지 않는다.
  const size = fitTextSize(ctx, key, state);
  if (size >= READABLE_SIZE) return { size, ...keep };

  // 2) 상자 자체가 문제인 경우 — 말풍선을 벗어났거나(너무 큼), 반대로 너무 작아서
  //    글자가 읽을 수 없을 만큼 줄어든 경우다. 기본값으로 통째로 되돌리면
  //    '위치·크기 되돌리기'와 다를 게 없어지므로, 사용자가 잡아 둔 자리를 지키면서
  //    상자만 손본다. 지금 크기에서 줄여 보고, 그래도 글자가 너무 작으면 기본
  //    크기에서 다시 시도하고, 마지막으로 완전 초기값까지 후보에 넣어 제일 나은 걸 쓴다.
  const box = textBox(key, ts);
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const anchor = bubbleAnchor(key);

  const sizeOf = (next) => fitTextSize(
    ctx, key, { ...state, texts: { ...state.texts, [key]: { ...ts, ...next } } },
  );

  const cands = [];
  for (const [w0, h0] of [[box.w, box.h], [def.w, def.h]]) {
    const placed = placeBoxInBubble(key, center, anchor, w0, h0);
    if (!placed) continue;
    const next = {
      dx: Math.round(placed.x - def.x),
      dy: Math.round(placed.y - def.y),
      w: Math.round(placed.w),
      h: Math.round(placed.h),
    };
    cands.push({ size: sizeOf(next), ...next });
  }
  const reset = { dx: 0, dy: 0, w: def.w, h: def.h };
  cands.push({ size: sizeOf(reset), ...reset });

  // 가장 큰 글자를 낼 수 있는 후보. 같으면 앞쪽(=사용자 자리를 지킨 쪽)이 이긴다.
  cands.sort((a, b) => b.size - a.size);
  return cands[0];
}

/** 중심을 되도록 지키면서, 말풍선 안에 들어갈 때까지 줄여 가며 자리를 찾는다. */
function placeBoxInBubble(key, center, anchor, w0, h0) {
  for (let k = 0; k <= 30; k++) {
    const shrink = Math.pow(0.93, k);
    const w = Math.max(MIN_TEXT_BOX, w0 * shrink);
    const h = Math.max(MIN_TEXT_BOX, h0 * shrink);
    for (let m = 0; m <= 10; m++) {
      const t = m / 10;
      const cx = center.x * (1 - t) + anchor.x * t;
      const cy = center.y * (1 - t) + anchor.y * t;
      if (boxInsideBubble(key, cx - w / 2, cy - h / 2, w, h)) {
        return { x: cx - w / 2, y: cy - h / 2, w, h };
      }
    }
  }
  return null;
}

/** 사각형이 통째로 말풍선 안인가. 격자로 훑는다. */
function boxInsideBubble(key, x, y, w, h) {
  const N = 6;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      if (!insideBubble(key, x + (w * i) / N, y + (h * j) / N)) return false;
    }
  }
  return true;
}
