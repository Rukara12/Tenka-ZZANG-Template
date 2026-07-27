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

import { CANVAS, SLOTS, SLOT_MAP } from './config.js';

/** 이 값 이상 덮여 있으면 가려진 것으로 본다. (0=완전 투명, 255=완전 불투명) */
const ALPHA_CUT = 128;

const measured = new Map();
let ready = false;

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

  for (const slot of SLOTS) {
    if (slot.above) continue; // 그림 위에 그리는 칸(로고)은 뚫려 있을 필요가 없다

    const r = slot.rect;
    const x0 = Math.max(0, r.x), x1 = Math.min(CANVAS.w, r.x + r.w);
    const y0 = Math.max(0, r.y), y1 = Math.min(CANVAS.h, r.y + r.h);

    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, open = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * CANVAS.w;
      for (let x = x0; x < x1; x++) {
        if (data[(row + x) * 4 + 3] >= ALPHA_CUT) continue;
        open++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) continue; // 구멍이 없다 — 사각형을 그대로 쓴다

    measured.set(slot.key, {
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      ratio: open / Math.max(1, (x1 - x0) * (y1 - y0)),
    });
  }

  ready = measured.size > 0;
  return ready;
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

export function holesReady() {
  return ready;
}
