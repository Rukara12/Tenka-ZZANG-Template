// 템플릿 고정값. 원본 에디터의 좌표를 그대로 승계한다.

export const CANVAS = { w: 1024, h: 765 };
export const OVERLAY_SRC = 'tenka.png';

/** 사진이 들어가는 구멍. above=true 면 템플릿 그림 위에 그린다(로고). */
export const SLOTS = [
  { key: 'bubble', label: '말풍선', rect: { x: 200, y: 0, w: 700, h: 440 }, above: false, hint: '말풍선 안에 들어갈 사진' },
  { key: 'phone', label: '핸드폰', rect: { x: 531, y: 470, w: 90, h: 150 }, above: false, hint: '핸드폰 화면' },
  { key: 'logo', label: '로고', rect: { x: 635, y: 415, w: 380, h: 340 }, above: true, hint: '게임 로고' },
];

export const SLOT_MAP = Object.fromEntries(SLOTS.map((s) => [s.key, s]));

export const TEXTS = [
  {
    key: 'tl', label: '좌상단',
    box: { x: 1, y: 1, w: 215, h: 330 }, size: 41,
    text: '텐카쨩 반박하는 내용··· 듣기 싫은 말···',
  },
  {
    key: 'bl', label: '좌하단',
    box: { x: 1, y: 420, w: 230, h: 350 }, size: 24,
    text: '나쨩 미안··· 잘 안 들려··· 아무튼 어쩌구 저쩌구 한데다 이러저러하고 이래저래 장점이 많아서 재밌는 게임이라는 장황한 설명···',
  },
  {
    key: 'tr', label: '우상단',
    box: { x: 810, y: 1, w: 215, h: 410 }, size: 44,
    text: '나쨩 이거 봐봐···! 대충 어쩌구 저쩌구 갓겜···!',
  },
];

export const TEXT_MAP = Object.fromEntries(TEXTS.map((t) => [t.key, t]));

export const BASE_FONT = 'PyeongtaekSunset';

export const LIMITS = {
  maxGifFrames: 400,     // 소스 GIF 1개에서 받아들일 최대 프레임
  maxExportFrames: 300,  // 내보내기 프레임 상한
  minFontSize: 8,
  maxFontSize: 200,
};

export const LINKS = {
  legacy: 'https://Rukara12.github.io/Tenka-ZZANG-Template/old/old.html',
  repo: 'https://github.com/Rukara12/Tenka-ZZANG-Template',
  sgdb: (term) => `https://www.steamgriddb.com/search/grids?term=${encodeURIComponent(term)}`,
};

export function defaultState() {
  const slots = {};
  for (const s of SLOTS) slots[s.key] = null;
  const texts = {};
  for (const t of TEXTS) {
    texts[t.key] = { text: t.text, size: t.size, auto: false, color: '#000000', dx: 0, dy: 0, w: t.box.w };
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
      scale: clampNum(p.scale, 1, 0.02, 40),
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
      w: clampNum(ts.w, d.w, 40, CANVAS.w),
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

/** 슬롯에 처음 사진이 들어갈 때의 배치값. */
export function defaultPlacement(slotKey, imgW, imgH) {
  const { rect } = SLOT_MAP[slotKey];
  // 구멍을 가득 채우되 잘림을 최소화 (cover)
  const scale = Math.max(rect.w / imgW, rect.h / imgH);
  return {
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
    scale,
    angle: 0,
    flip: false,
  };
}
