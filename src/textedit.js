// 텍스트 편집은 캔버스에 직접 구현하지 않고, 투명한 <textarea>를 정확히 겹쳐서 처리한다.
// 커서·선택·되돌리기·그리고 무엇보다 한글 조합(IME)을 브라우저가 그대로 처리하게 하려는 것.

import { LIMITS } from './config.js';
import { textBox } from './renderer.js';
import { wrap } from './text.js';

export class TextEditor {
  /**
   * @param {HTMLElement} host 스테이지 래퍼 (position: relative)
   * @param {Editor} editor
   * @param {() => number} viewScale
   * @param {object} hooks { onChange, onDone, measureCtx }
   */
  constructor(host, editor, viewScale, hooks) {
    this.host = host;
    this.editor = editor;
    this.viewScale = viewScale;
    this.hooks = hooks;
    this.key = null;

    const ta = document.createElement('textarea');
    ta.className = 'text-overlay';
    ta.spellcheck = false;
    ta.setAttribute('aria-label', '문구 편집');
    ta.addEventListener('input', () => this.onInput());
    ta.addEventListener('blur', () => this.finish());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 전역 단축키가 편집을 가로채지 않도록
      if (e.key === 'Escape') { e.preventDefault(); this.finish(); }
    });
    host.appendChild(ta);
    this.ta = ta;
  }

  get active() { return this.key !== null; }

  start(key) {
    if (this.key === key) return;
    this.key = key;
    const ts = this.editor.state.texts[key];
    this.ta.value = ts.text;
    this.ta.classList.add('is-active');
    this.layout();
    this.ta.focus();
    this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
    this.hooks.onChange?.();
  }

  finish() {
    if (!this.key) return;
    this.key = null;
    this.ta.classList.remove('is-active');
    this.editor.seal();
    this.hooks.onDone?.();
    this.hooks.onChange?.();
  }

  onInput() {
    if (!this.key) return;
    const key = this.key;
    this.editor.update((st) => { st.texts[key].text = this.ta.value; }, { coalesce: `type:${key}` });
    this.layout();
    this.hooks.onChange?.();
  }

  /** 캔버스 렌더 결과와 픽셀 단위로 맞춘다. */
  layout() {
    if (!this.key) return;
    const st = this.editor.state;
    const ts = st.texts[this.key];
    const box = textBox(this.key, ts);
    const vs = this.viewScale();
    const ctx = this.hooks.measureCtx();

    const size = ts.auto
      ? fitAuto(ctx, ts.text, st.font, box)
      : ts.size;
    const m = wrap(ctx, ts.text, size, st.font, box.w);

    const s = this.ta.style;
    s.left = `${box.x * vs}px`;
    s.top = `${box.y * vs}px`;
    s.width = `${box.w * vs}px`;
    s.height = `${box.h * vs}px`;
    s.fontSize = `${size * vs}px`;
    s.lineHeight = `${m.lineHeight * vs}px`;
    s.fontFamily = `"${st.font}", sans-serif`;
    s.color = ts.color || '#000';
    s.paddingTop = `${Math.max(0, (box.h - m.height) / 2) * vs}px`;
  }
}

function fitAuto(ctx, text, family, box) {
  let lo = LIMITS.minFontSize, hi = LIMITS.maxFontSize, best = lo;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const m = wrap(ctx, text, mid, family, box.w);
    if (m.height <= box.h && m.width <= box.w) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}
