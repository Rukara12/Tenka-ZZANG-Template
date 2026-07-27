// 템플릿 그림에서 '사진이 실제로 비치는 영역'을 재둔다.
//
// SLOTS 의 사각형은 넉넉하게 잡은 자르기 범위일 뿐이고, 진짜로 보이는 곳은
// tenka.png 가 뚫려 있는 부분이다. 말풍선은 사각형 700×440 중 35% 만 비치고
// 나머지는 불투명한 그림에 덮인다. 사각형을 기준으로 안내하면 사용자는 보이지도
// 않는 자리에 사진을 맞추게 되므로, 여기서 한 번 재서 나머지 코드가 이 값을 쓴다.
//
// 화면에 그리는 마스킹 자체는 이 모듈의 사각형이 아니라 renderer.js 에서
// overlay 이미지를 그대로 합성 마스크로 써서 처리한다. 그래야 알파가 있는 그대로,
// 경계의 안티에일리어싱까지 픽셀 단위로 정확하다. 여기서 재는 사각형은
// 자동 배치와 안내 문구 위치처럼 '대표값'이 필요한 곳에만 쓴다.

import { CANVAS, SLOTS, SLOT_MAP, TEXTS, TEXT_MAP } from './config.js';

// 완전히 불투명하지 않으면 사진이 조금이라도 비친다 — 그러니 '구멍'으로 친다.
// 128 로 자르면 반투명하게 번진 가장자리가 구멍 밖으로 밀려나고, 거기에 딱 맞춰
// 사진을 채우면 그 테두리에 흰 배경이 비쳐 옅은 띠로 남는다.
const ALPHA_CUT = 250;

/** 말풍선으로 볼 밝기. 불투명하면서 거의 흰 픽셀. */
const WHITE_CUT = 246;

const measured = new Map();
let ready = false;

// 픽셀마다 '몇 번 구멍인지'(0=구멍 아님). 누를 수 있는 자리를 사각형이 아니라
// 실제 구멍 모양으로 판정하는 데 쓴다.
let holeMask = null;
const holeId = new Map();

// 문구별 말풍선 영역. 픽셀마다 '몇 번 말풍선인지'(0=아님)를 담는다.
let bubbleMask = null;
const bubbleId = new Map(); // 문구 키 -> 번호
const bubbleCenter = new Map(); // 문구 키 -> 말풍선 안쪽 기준점
let bubblesOk = false;

/**
 * 템플릿 그림의 알파를 훑어 칸마다 실제로 뚫린 범위를 잰다.
 * 시작할 때 한 번만 부르면 된다.
 *
 * @param {HTMLImageElement|null} overlay
 * @returns {boolean} 쟀으면 true
 */
export function measureHoles(overlay) {
  measured.clear();
  ready = false;
  if (!overlay || !overlay.naturalWidth) return false;

  let data;
  try {
    const c = document.createElement('canvas');
    c.width = CANVAS.w;
    c.height = CANVAS.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(overlay, 0, 0, CANVAS.w, CANVAS.h);
    data = ctx.getImageData(0, 0, CANVAS.w, CANVAS.h).data;
  } catch {
    return false; // 다른 출처의 이미지라 캔버스가 오염된 경우 — 사각형으로 물러난다
  }

  holeMask = new Uint8Array(CANVAS.w * CANVAS.h);
  holeId.clear();

  SLOTS.forEach((slot, n) => {
    if (slot.above) return; // 그림 위에 그리는 칸(로고)은 뚫려 있을 필요가 없다

    const id = n + 1;
    const r = slot.rect;
    const x0 = Math.max(0, r.x), x1 = Math.min(CANVAS.w, r.x + r.w);
    const y0 = Math.max(0, r.y), y1 = Math.min(CANVAS.h, r.y + r.h);

    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, open = 0;
    let sumX = 0, sumY = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * CANVAS.w;
      for (let x = x0; x < x1; x++) {
        if (data[(row + x) * 4 + 3] >= ALPHA_CUT) continue;
        holeMask[row + x] = id;
        open++;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return; // 구멍이 없다 — 사각형을 그대로 쓴다
    holeId.set(slot.key, id);

    const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    measured.set(slot.key, {
      ...box,
      ratio: open / Math.max(1, (x1 - x0) * (y1 - y0)),
      label: pickLabelPoint(data, box, sumX / open, sumY / open),
    });
  });

  measureBubbles(data);

  ready = measured.size > 0;
  return ready;
}

/* ---------- 대화문이 들어가는 흰 말풍선 ---------- */

/**
 * 문구마다 자기 말풍선의 픽셀 범위를 잡아 둔다.
 *
 * 문구가 넘쳤는지는 '입력 상자를 벗어났는지'가 아니라 '말풍선 밖으로 나갔는지'로
 * 따져야 한다. 상자는 편의상 그은 사각형일 뿐이고, 실제로 보기 흉해지는 건 글자가
 * 흰 말풍선을 벗어나 그림 위로 올라탈 때다.
 *
 * 연결 성분을 전부 라벨링하지 않고 문구 상자 한가운데에서 칠해 나간다.
 * 상자는 말풍선에 맞춰 잡혀 있으므로 씨앗이 곧 그 말풍선 안이고, 짝짓기도 공짜다.
 */
function measureBubbles(data) {
  bubbleMask = null;
  bubbleId.clear();
  bubbleCenter.clear();
  bubblesOk = false;

  const { w: W, h: H } = CANVAS;
  const isWhite = (i) => {
    const p = i * 4;
    return data[p + 3] === 255 &&
      data[p] >= WHITE_CUT && data[p + 1] >= WHITE_CUT && data[p + 2] >= WHITE_CUT;
  };

  const mask = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let painted = 0;

  TEXTS.forEach((t, n) => {
    const id = n + 1;
    const b = t.box;
    let seed = -1;

    // 상자 한가운데에서 시작하되, 하필 글자나 테두리에 걸렸으면 주변을 조금 훑는다.
    outer:
    for (const frac of [0, 0.15, 0.3]) {
      for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = Math.round(b.x + b.w / 2 + ox * b.w * frac);
        const y = Math.round(b.y + b.h / 2 + oy * b.h * frac);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (isWhite(i) && !mask[i]) { seed = i; break outer; }
      }
    }
    if (seed < 0) return;

    let sp = 0;
    stack[sp++] = seed;
    mask[seed] = id;
    let count = 0;
    let sumX = 0, sumY = 0;
    while (sp > 0) {
      const i = stack[--sp];
      count++;
      sumX += i % W;
      sumY += (i / W) | 0;
      const x = i % W;
      if (x > 0 && !mask[i - 1] && isWhite(i - 1)) { mask[i - 1] = id; stack[sp++] = i - 1; }
      if (x < W - 1 && !mask[i + 1] && isWhite(i + 1)) { mask[i + 1] = id; stack[sp++] = i + 1; }
      if (i >= W && !mask[i - W] && isWhite(i - W)) { mask[i - W] = id; stack[sp++] = i - W; }
      if (i < W * H - W && !mask[i + W] && isWhite(i + W)) { mask[i + W] = id; stack[sp++] = i + W; }
    }
    if (count > 2000) {
      bubbleId.set(t.key, id);
      // 말풍선 안쪽 기준점. 상자를 말풍선 안으로 끌어들일 때 목표가 된다.
      const cx = Math.round(sumX / count);
      const cy = Math.round(sumY / count);
      const inside = mask[cy * W + cx] === id;
      bubbleCenter.set(t.key, inside
        ? { x: cx, y: cy }
        : { x: b.x + b.w / 2, y: b.y + b.h / 2 });
      painted++;
    }
  });

  if (painted === TEXTS.length) {
    bubbleMask = mask;
    bubblesOk = true;
  }
}

/** 이 점이 그 문구의 말풍선 안인가. */
export function insideBubble(textKey, x, y) {
  if (!bubblesOk) return true; // 못 쟀으면 판정을 포기한다 (거짓 경고보다 낫다)
  const id = bubbleId.get(textKey);
  if (!id) return true;
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= CANVAS.w || py >= CANVAS.h) return false;
  return bubbleMask[py * CANVAS.w + px] === id;
}

export function bubblesReady() {
  return bubblesOk;
}

/** 말풍선 안쪽 기준점. 상자를 말풍선 안으로 끌어들일 때의 목표 지점. */
export function bubbleAnchor(textKey) {
  const c = bubbleCenter.get(textKey);
  if (c) return c;
  const b = TEXT_MAP[textKey].box;
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

const isOpen = (data, x, y) =>
  x >= 0 && y >= 0 && x < CANVAS.w && y < CANVAS.h &&
  data[(y * CANVAS.w + x) * 4 + 3] < ALPHA_CUT;

/**
 * 안내 문구를 놓을 자리.
 *
 * 외접 사각형의 한가운데는 쓸 수 없다. 말풍선은 아래로 뻗은 꼬리 때문에 사각형이
 * 세로로 늘어나 있어서, 그 중심이 실제 구멍의 몸통보다 74px 아래에 찍힌다.
 * 무게중심이 훨씬 정직하고, 오목한 모양이라 무게중심이 구멍 밖으로 나가면
 * 그때만 가장 가까운 구멍 픽셀로 물러난다.
 */
function pickLabelPoint(data, box, cx, cy) {
  const rx = Math.round(cx), ry = Math.round(cy);
  if (isOpen(data, rx, ry)) return { x: cx, y: cy };

  const mx = Math.round(box.x + box.w / 2), my = Math.round(box.y + box.h / 2);
  if (isOpen(data, mx, my)) return { x: mx, y: my };

  let best = null, bestD = Infinity;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (!isOpen(data, x, y)) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best || { x: mx, y: my };
}

/**
 * 사진이 실제로 비치는 범위(구멍의 외접 사각형).
 * 아직 재지 않았거나 구멍이 없으면 SLOTS 의 사각형을 그대로 준다.
 */
export function visibleRect(slotKey) {
  return measured.get(slotKey) || SLOT_MAP[slotKey].rect;
}

/** 칸 넓이 대비 실제로 비치는 비율. 못 쟀으면 1. */
export function visibleRatio(slotKey) {
  return measured.get(slotKey)?.ratio ?? 1;
}

/** 안내 문구를 놓을 자리. 못 쟀으면 사각형 한가운데. */
export function labelPoint(slotKey) {
  const m = measured.get(slotKey);
  if (m) return m.label;
  const r = SLOT_MAP[slotKey].rect;
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function holesReady() {
  return ready;
}

/**
 * 이 점이 그 칸의 구멍 안인가.
 *
 * 누를 수 있는 자리를 사각형이 아니라 실제 구멍 모양으로 본다. 말풍선의 사각형은
 * 구멍보다 한참 넓어서(700x440 대 528x415), 사각형으로 판정하면 말풍선 바깥의
 * 그림을 눌러도 말풍선이 잡혀 버린다.
 */
export function insideHole(slotKey, x, y) {
  const id = holeId.get(slotKey);
  if (!id || !holeMask) return false;
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= CANVAS.w || py >= CANVAS.h) return false;
  return holeMask[py * CANVAS.w + px] === id;
}

/** 구멍 모양으로 판정할 수 있는 상태인가. */
export function holeMaskReady() {
  return !!holeMask && holeId.size > 0;
}
