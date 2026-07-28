// 템플릿 고정값. 원본 에디터의 좌표를 그대로 승계한다.

export const CANVAS = { w: 1024, h: 765 };
export const OVERLAY_SRC = 'tenka.png';

/** 사진이 들어가는 구멍. above=true 면 템플릿 그림 위에 그린다(로고). */
export const SLOTS = [
  { key: 'bubble', label: '말풍선', rect: { x: 200, y: 0, w: 700, h: 440 }, above: false, hint: '말풍선 안에 들어갈 사진' },
  { key: 'phone', label: '핸드폰', rect: { x: 531, y: 470, w: 90, h: 150 }, above: false, hint: '핸드폰 화면' },
  // 로고는 아래를 그대로 두고 위만 내려 높이를 줄였다 (340 → 300).
  { key: 'logo', label: '로고', rect: { x: 635, y: 455, w: 380, h: 300 }, above: true, hint: '게임 로고' },
];

export const SLOT_MAP = Object.fromEntries(SLOTS.map((s) => [s.key, s]));

/**
 * above 칸의 빈 자리 안내 띠. 마스킹 영역 전체를 덮지 않고 좌하단에 낮게 깔린다.
 * 그리는 쪽(renderer)과 누르는 쪽(interact)이 같은 값을 봐야 하므로 여기에 둔다.
 */
export const GUIDE_BAND = { w: 310, h: 46, inset: 6, bottom: 16 };

export function guideBandRect(slotKey) {
  const r = SLOT_MAP[slotKey].rect;
  return {
    x: r.x + GUIDE_BAND.inset,
    y: r.y + r.h - GUIDE_BAND.h - GUIDE_BAND.bottom,
    w: Math.min(GUIDE_BAND.w, r.w - GUIDE_BAND.inset * 2),
    h: GUIDE_BAND.h,
  };
}

// 문구 상자는 말풍선 안에 들어가는 사각형이되, 말풍선의 '무게중심'에 맞춰 잡았다.
//
// 말풍선은 네모가 아니라 울퉁불퉁한 구름 모양이다. 그래서 '면적이 가장 큰 내접
// 사각형'을 그대로 쓰면 구름 한쪽 끝에 붙어 버린다 — 예전 값은 좌상단이 위로,
// 좌하단이 아래로, 우상단이 오른쪽으로 쏠려서 중심에서 18~36px 어긋나 있었다.
// 글자는 상자 안에서 가운데 정렬이므로 그 쏠림이 그대로 보인다.
//
// 높이는 '사각형 전체가 말풍선 안'이 아니라 '가운데 기둥(폭의 80%)이 말풍선 안'을
// 기준으로 잡았다. 글자는 상자 안에서 가운데 정렬이고 첫 줄·끝 줄은 대개 짧아서,
// 사각형의 네 귀퉁이까지 말풍선 안이어야 할 이유가 없다. 이 기준으로 바꾸면서
// 세 칸 모두 높이가 30~50px 늘었다.
//
// 너비도 이 기준에서 다시 재면 여유가 생긴다. 사각형 전체를 요구할 때는 우상단이
// 195 를 넘기는 순간 높이가 303 에서 159 로 주저앉았는데, 가운데 기둥 기준이면
// 205 에서도 364 가 나온다. 구름의 잘록한 곳에 걸리는 건 귀퉁이뿐이기 때문이다.
export const TEXTS = [
  {
    key: 'tl', label: '좌상단',
    box: { x: 21, y: 11, w: 167, h: 290 }, size: 42,
    text: '텐카쨩 반박하는 내용···\n듣기 싫은 말···',
  },
  {
    key: 'bl', label: '좌하단',
    box: { x: 13, y: 442, w: 205, h: 313 }, size: 27,
    text: '나쨩 미안···\n잘 안 들려···\n아무튼 어쩌구 저쩌구 한데다 이러저러하고 이래저래 장점이 많아서 재밌는 게임이라는 장황한 설명···',
  },
  {
    key: 'tr', label: '우상단',
    box: { x: 815, y: 11, w: 205, h: 364 }, size: 42,
    text: '나쨩 이거 봐봐···!\n대충 어쩌구 저쩌구 갓겜···!',
  },
];

export const TEXT_MAP = Object.fromEntries(TEXTS.map((t) => [t.key, t]));

export const BASE_FONT = 'PyeongtaekSunset';

/** 문구 상자의 최소 변 길이. */
export const MIN_TEXT_BOX = 40;

export const LIMITS = {
  maxGifFrames: 400,     // 소스 GIF 1개에서 받아들일 최대 프레임
  maxExportFrames: 300,  // 내보내기 프레임 상한
  minFontSize: 8,
  maxFontSize: 200,
  // 사진 배율 한계. 손잡이·휠·핀치·슬라이더가 모두 이 값을 써야 한다 —
  // 예전엔 슬라이더만 600% 로 막혀 있어서, 휠로 키운 뒤 슬라이더를 건드리면
  // 사진이 600% 로 튀어 돌아갔다.
  // 8000px 사진을 핸드폰 화면(59x106)에 맞추면 1.8%, 32px 아이콘을 말풍선에
  // 채우면 1631% 가 필요하다. 양쪽 다 실제로 일어나므로 한계는 넉넉해야 한다.
  minScale: 0.005,
  maxScale: 40,
};

export const LINKS = {
  legacy: 'https://Rukara12.github.io/Tenka-ZZANG-Template/old/old.html',
  repo: 'https://github.com/Rukara12/Tenka-ZZANG-Template',
  sgdb: (term) => `https://www.steamgriddb.com/search/grids?term=${encodeURIComponent(term)}`,
  // 대사를 지어 주는 Gemini Gem. 게임 이름만 넣으면 세 도막을 JSON 으로 내놓는다.
  gem: 'https://gemini.google.com/gem/0bbb8cb862d9?usp=sharing',
};

export function defaultState() {
  const slots = {};
  for (const s of SLOTS) slots[s.key] = null;
  const texts = {};
  for (const t of TEXTS) {
    texts[t.key] = {
      text: t.text, size: t.size, auto: false, color: '#000000',
      dx: 0, dy: 0, w: t.box.w, h: t.box.h,
    };
  }
  return {
    v: 1,
    slots,
    texts,
    effects: {
      shadow: { on: false, blur: 10, dx: 5, dy: 5, color: '#000000' },
      outline: { on: false, width: 2.5, color: '#000000' },
    },
    font: BASE_FONT,
  };
}

/* ---------- 저장본 마이그레이션 ---------- */

const clampNum = (v, fallback, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

const okColor = (v, fallback) =>
  (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

/**
 * 저장된 상태를 현재 스키마에 맞춘다.
 *
 * 통째로 얕은 병합을 하면 SLOTS·TEXTS 에 항목을 추가한 순간 기존 사용자의
 * 저장본에 그 키가 없어 렌더러가 undefined 를 읽고 죽는다. 저장본은 새로고침해도
 * 다시 읽히므로 사용자가 스스로 빠져나올 수 없다. 그래서 키 단위로 병합하고,
 * 값 범위도 여기서 한 번 걸러 손상된 저장본이 UI 로 새어 나가지 않게 한다.
 *
 * @param {unknown} saved
 * @returns {object} 항상 완전한 상태
 */
export function migrateState(saved) {
  const base = defaultState();
  if (!saved || typeof saved !== 'object') return base;

  for (const s of SLOTS) {
    const p = saved.slots?.[s.key];
    if (!p || typeof p !== 'object' || !p.asset) continue;
    base.slots[s.key] = {
      asset: String(p.asset),
      x: clampNum(p.x, s.rect.x + s.rect.w / 2, -CANVAS.w * 4, CANVAS.w * 4),
      y: clampNum(p.y, s.rect.y + s.rect.h / 2, -CANVAS.h * 4, CANVAS.h * 4),
      scale: clampNum(p.scale, 1, LIMITS.minScale, LIMITS.maxScale),
      angle: clampNum(p.angle, 0, 0, 360),
      flip: !!p.flip,
    };
  }

  for (const t of TEXTS) {
    const ts = saved.texts?.[t.key];
    if (!ts || typeof ts !== 'object') continue;
    const d = base.texts[t.key];
    base.texts[t.key] = {
      text: typeof ts.text === 'string' ? ts.text : d.text,
      size: clampNum(ts.size, d.size, LIMITS.minFontSize, LIMITS.maxFontSize),
      auto: !!ts.auto,
      color: okColor(ts.color, d.color),
      dx: clampNum(ts.dx, 0, -CANVAS.w, CANVAS.w),
      dy: clampNum(ts.dy, 0, -CANVAS.h, CANVAS.h),
      w: clampNum(ts.w, d.w, MIN_TEXT_BOX, CANVAS.w),
      h: clampNum(ts.h, d.h, MIN_TEXT_BOX, CANVAS.h),
    };
  }

  const fx = saved.effects || {};
  base.effects.shadow = {
    on: !!fx.shadow?.on,
    blur: clampNum(fx.shadow?.blur, 10, 0, 60),
    dx: clampNum(fx.shadow?.dx, 5, -60, 60),
    dy: clampNum(fx.shadow?.dy, 5, -60, 60),
    color: okColor(fx.shadow?.color, '#000000'),
  };
  base.effects.outline = {
    on: !!fx.outline?.on,
    width: clampNum(fx.outline?.width, 2.5, 0, 20),
    color: okColor(fx.outline?.color, '#000000'),
  };

  if (typeof saved.font === 'string' && saved.font) base.font = saved.font;
  return base;
}

/**
 * 슬롯에 처음 사진이 들어갈 때의 배치값.
 *
 * @param {string} slotKey
 * @param {number} imgW
 * @param {number} imgH
 * @param {{x:number,y:number,w:number,h:number}} [target]
 *        맞출 범위. 넘기지 않으면 SLOTS 의 사각형. 실제로는 mask.js 가 잰
 *        '진짜로 비치는 범위'를 넘겨받는다 — 사각형은 구멍보다 훨씬 넓어서
 *        그대로 맞추면 보이지도 않는 여백까지 덮느라 과하게 확대된다.
 */
/**
 * 칸을 채울 때 가장자리를 넘어 조금 더 물리는 양(px).
 *
 * 구멍의 가장자리는 반투명하게 번져 있어서, 딱 맞게 채우면 그 테두리에 흰 배경이
 * 비쳐 옅은 띠로 남는다. 말풍선 꼬리처럼 좁은 곳일수록 눈에 띈다. 조금 넘겨 채운다.
 */
function bleedFor(rect) {
  return Math.max(4, Math.min(rect.w, rect.h) * 0.03);
}

export function defaultPlacement(slotKey, imgW, imgH, target) {
  const rect = target || SLOT_MAP[slotKey].rect;
  // 구멍을 가득 채우되 잘림을 최소화 (cover). 가장자리는 조금 넘겨 문다.
  const bleed = bleedFor(rect) * 2;
  const scale = Math.max((rect.w + bleed) / imgW, (rect.h + bleed) / imgH);
  return {
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
    scale,
    angle: 0,
    flip: false,
  };
}
