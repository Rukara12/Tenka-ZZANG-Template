// 밖에서 만들어 온 대사를 읽어들인다.
//
// 이 짤방의 이야기 흐름은 이렇다.
//   (1) 우상단 — 텐카쨩이 담담한 얼굴로 똥겜을 갓겜이라며 권한다
//   (2) 좌상단 — 나쨩이 정색하고 지적한다 ("그거 개똥겜이잖아~")
//   (3) 좌하단 — 텐카쨩이 못 들은 척하며("잘 안 들려···") 장황하게 옹호한다
//
// 표준 형식은 JSON 이다.
//
//   {
//     "게임": "게임 이름",
//     "우상단": "텐카쨩이 담담하게 권하는 말",
//     "좌상단": "나쨩의 반박",
//     "좌하단": "텐카쨩이 못 들은 척하며 늘어놓는 옹호"
//   }
//
// 다만 사람이 손으로 옮기거나 AI 가 형식을 살짝 어기는 일이 흔하므로 넉넉하게 받는다.
// 코드 울타리(```)에 싸여 있어도, 앞뒤에 설명이 붙어 있어도, 키를 영문(tr/tl/bl)으로
// 썼어도, 아예 JSON 이 아니라 번호 매긴 세 줄이어도 읽는다.
// 읽지 못하면 조용히 null 을 돌려주고 호출한 쪽이 판단한다.

/** 칸 이름 → 내부 키. 공백을 지운 소문자로 비교한다. */
const KEY_MAP = {
  좌상단: 'tl', 왼쪽위: 'tl', tl: 'tl',
  좌하단: 'bl', 왼쪽아래: 'bl', bl: 'bl',
  우상단: 'tr', 오른쪽위: 'tr', tr: 'tr',
};

/** 번호만 매겨진 경우의 순서. 이야기 흐름대로 권유 → 반박 → 옹호. */
const BY_ORDER = ['tr', 'tl', 'bl'];

const MAX_LEN = 300;

function clean(v) {
  return String(v)
    .replace(/^\s*["'“”‘’]+|["'“”‘’]+\s*$/g, '') // 따옴표로 감싼 경우
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, MAX_LEN);
}

/* ---------- 정해진 자리의 줄바꿈 ---------- */
//
// 세 도막은 첫머리가 고정돼 있다. 우상단은 "나쨩 이거 봐봐···!" 로 열고, 좌상단은
// "···" 로 끝나는 문장 둘이며, 좌하단은 "나쨩 미안··· 잘 안 들려···" 로 시작한다.
// 그 자리의 줄바꿈은 취향이 아니라 형식이므로 받아 읽는 쪽에서 넣는다.
//
// 이 일을 AI 지시문에 맡기지 않는 이유가 있다. 규칙을 하나 더 얹으면 나머지 규칙의
// 준수율이 같이 떨어지고, JSON 문자열 안의 \n 은 모델이 자주 틀린다(진짜 개행을
// 넣어 JSON 을 깨거나 \\n 으로 두 번 이스케이프한다). 여기서 넣으면 손으로 쓴
// 대사에도, 다른 데서 가져온 대사에도 똑같이 걸린다.
//
// 다만 뼈대를 어긴 글에 억지로 칼을 대면 엉뚱한 데서 끊긴다. 그래서 정해진 무늬가
// 맞아떨어질 때만 넣고, 안 맞으면 손대지 않는다. 이미 줄바꿈이 있으면 쓴 사람의
// 뜻으로 보고 그대로 둔다.

/** 말줄임표 표기 흔들림. 가운뎃점 셋이 정석이지만 …·⋯·... 도 들어온다. */
const ELL = '(?:···|⋯|…|\\.{2,})';
const re = (s) => new RegExp(s);

const BREAKS = {
  // 나쨩 이거 봐봐···! ↵ 대충 어쩌구 갓겜···!
  tr: [[re(`^(나쨩 ?이거 ?봐봐${ELL}!) +`), '$1\n']],
  // 첫 문장··· ↵ 둘째 문장···   (끝의 ··· 뒤에는 글자가 없으므로 걸리지 않는다)
  tl: [[re(`^(.{2,}?${ELL}) +(?=\\S)`), '$1\n']],
  // 나쨩 미안··· ↵ 잘 안 들려··· ↵ 아무튼 …
  bl: [[re(`^(나쨩 ?미안${ELL}) +(잘 ?안 ?들려${ELL}) +`), '$1\n$2\n']],
};

/**
 * 칸의 뼈대에 맞춰 정해진 자리에 줄바꿈을 넣는다.
 * 무늬가 안 맞거나 이미 줄바꿈이 있으면 원문 그대로 돌려준다.
 */
export function breakLines(key, text) {
  if (typeof text !== 'string' || text.includes('\n')) return text;
  let out = text;
  for (const [pattern, into] of BREAKS[key] || []) out = out.replace(pattern, into);
  return out;
}

const norm = (k) => String(k).replace(/\s+/g, '').toLowerCase();

function pickGame(obj) {
  for (const k of ['게임', '게임명', '게임이름', 'game', 'title']) {
    const v = obj[k] ?? obj[norm(k)];
    if (typeof v === 'string' && v.trim()) return clean(v);
  }
  return '';
}

function collect(src) {
  const texts = {};
  if (!src || typeof src !== 'object') return texts;
  for (const [k, v] of Object.entries(src)) {
    const key = KEY_MAP[norm(k)];
    if (key && typeof v === 'string' && v.trim()) texts[key] = clean(v);
  }
  return texts;
}

function fromJson(raw) {
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  // 통째로 → 안 되면 본문에서 첫 { … } 덩어리만 (코드 울타리·군더더기 대응)
  let obj = parse(raw.trim());
  if (!obj) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) obj = parse(m[0]);
  }
  if (!obj || typeof obj !== 'object') return null;

  const texts = { ...collect(obj.texts), ...collect(obj.대사), ...collect(obj) };
  if (!Object.keys(texts).length) return null;
  return { game: pickGame(obj), texts };
}

function fromLines(raw) {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const texts = {};
  const rest = [];
  let game = '';

  for (const line of lines) {
    // "좌상단: 내용" / "1) 내용" / "1. 내용"
    const labeled = line.match(/^[-*\s]*([가-힣A-Za-z]+)\s*[:：]\s*(.+)$/);
    if (labeled) {
      const key = KEY_MAP[norm(labeled[1])];
      if (key) { texts[key] = clean(labeled[2]); continue; }
      if (['게임', '게임명', '게임이름', 'game', 'title'].includes(norm(labeled[1]))) {
        game = clean(labeled[2]);
        continue;
      }
    }
    const numbered = line.match(/^\s*(\d)\s*[).．.]\s*(.+)$/);
    if (numbered) { rest.push(clean(numbered[2])); continue; }
  }

  // 이름표가 하나도 없고 번호만 셋이면 정해진 순서로 채운다.
  if (!Object.keys(texts).length && rest.length >= 3) {
    BY_ORDER.forEach((key, i) => { texts[key] = rest[i]; });
  }

  if (!Object.keys(texts).length) return null;
  return { game, texts };
}

/**
 * @param {string} raw 파일 내용 또는 붙여넣은 글
 * @returns {{game:string, texts:{tl?:string,bl?:string,tr?:string}}|null}
 */
export function parseDialogue(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const got = fromJson(raw) || fromLines(raw);
  if (!got) return null;
  for (const key of Object.keys(got.texts)) {
    got.texts[key] = breakLines(key, got.texts[key]);
  }
  return got;
}

/** Gem 지시문에 넣을 형식 설명. 앱에서 그대로 복사해 줄 수 있게 여기 둔다. */
export const FORMAT_HINT = `{
  "게임": "게임 이름",
  "우상단": "텐카쨩이 담담하게 권하는 말",
  "좌상단": "나쨩의 반박",
  "좌하단": "텐카쨩이 못 들은 척하며 늘어놓는 옹호"
}`;
