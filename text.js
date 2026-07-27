// 캔버스 텍스트 레이아웃.
// 한국어는 어절(공백) 단위로 끊는 게 읽기 좋으므로 그걸 1순위로 하고,
// 한 어절이 상자보다 길 때만 자소 단위로 강제 분할한다. (CSS의 word-break:keep-all 과 같은 정책)

const LINE_HEIGHT = 1.22;

let segmenter = null;
function graphemes(str) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return [...segmenter.segment(str)].map((s) => s.segment);
  }
  return [...str];
}

export function fontSpec(size, family) {
  return `700 ${size}px "${family}", sans-serif`;
}

/**
 * 주어진 폭에 맞춰 줄을 나눈다.
 * @returns {{lines:string[], width:number, height:number, lineHeight:number}}
 */
export function wrap(ctx, text, size, family, maxWidth) {
  ctx.font = fontSpec(size, family);
  const lineHeight = size * LINE_HEIGHT;
  const lines = [];

  for (const paragraph of String(text).split('\n')) {
    if (paragraph === '') { lines.push(''); continue; }

    // 공백은 앞 조각에 붙여둔다 (줄 끝 공백이 폭에 영향을 주지 않도록)
    const tokens = paragraph.match(/[^\s]+\s*/g) || [paragraph];
    let line = '';

    for (const token of tokens) {
      const trial = line + token;
      if (ctx.measureText(trial.trimEnd()).width <= maxWidth || line === '') {
        if (ctx.measureText(token.trimEnd()).width > maxWidth && line === '') {
          // 어절 하나가 통째로 넘친다 — 자소 단위로 쪼갠다.
          let chunk = '';
          for (const g of graphemes(token)) {
            if (chunk && ctx.measureText(chunk + g).width > maxWidth) {
              lines.push(chunk);
              chunk = g.trimStart();
            } else {
              chunk += g;
            }
          }
          line = chunk;
          continue;
        }
        line = trial;
      } else {
        lines.push(line.trimEnd());
        line = token;
      }
    }
    lines.push(line.trimEnd());
  }

  let width = 0;
  for (const l of lines) width = Math.max(width, ctx.measureText(l).width);
  return { lines, width, height: lines.length * lineHeight, lineHeight };
}

/**
 * 상자에 들어가는 최대 글자 크기를 이분 탐색으로 찾는다.
 * 자동 맞춤이 켜졌을 때만 쓴다.
 */
export function fitSize(ctx, text, family, box, min, max) {
  let lo = min, hi = max, best = min;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const m = wrap(ctx, text, mid, family, box.w);
    if (m.height <= box.h && m.width <= box.w) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

/**
 * 상자 안에 세로 중앙, 가로 중앙 정렬로 그린다.
 * 원본 에디터의 세로 중앙 정렬 동작을 유지하되, 상자를 옮겨도 기준이 따라오도록 했다.
 */
export function drawText(ctx, text, size, family, box, color) {
  const m = wrap(ctx, text, size, family, box.w);
  ctx.font = fontSpec(size, family);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const top = box.y + Math.max(0, (box.h - m.height) / 2);
  const cx = box.x + box.w / 2;
  // 베이스라인 보정: 줄 높이 안에서 글자가 광학적으로 가운데 오도록
  const baseOffset = m.lineHeight * 0.5 + size * 0.35;

  for (let i = 0; i < m.lines.length; i++) {
    ctx.fillText(m.lines[i], cx, top + i * m.lineHeight + baseOffset);
  }
  return m;
}
