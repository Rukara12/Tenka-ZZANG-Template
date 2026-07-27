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
