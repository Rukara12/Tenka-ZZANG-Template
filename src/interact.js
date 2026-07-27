// 포인터 기반 직접 조작.
// 마우스와 터치를 Pointer Events 하나로 처리하므로 모바일에서 핀치 확대·회전이 그냥 된다.

import { CANVAS, SLOT_MAP, TEXTS, LIMITS } from './config.js';
import { getAsset } from './assets.js';
import { textBox } from './renderer.js';
import { wrap, fitSize, fontSpec } from './text.js';

const HANDLE = 9;       // 핸들 반지름(화면 px)
const HIT_SLOP = 14;    // 핸들 판정 여유
const ROTATE_ARM = 30;  // 회전 핸들이 상자 위로 떨어진 거리

const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const TEXT_PAD = 8;     // 글자 주변 여유 (캔버스 좌표)

// 글자 폭 계산 전용. 화면에 그리지 않는다.
const measure = document.createElement('canvas').getContext('2d');

export class Interactor {
  /**
   * @param {HTMLCanvasElement} overlayCanvas 핸들을 그릴 캔버스
   * @param {Editor} editor
   * @param {object} hooks { onSelect, onRequestUpload, onEditText, onChange }
   */
  constructor(overlayCanvas, editor, hooks) {
    this.el = overlayCanvas;
    this.editor = editor;
    this.hooks = hooks;
    this.selection = null;
    this.hovered = null;
    this.mode = null;
    this.pointers = new Map();
    this.hud = null;
    this._bind();
  }

  get state() { return this.editor.state; }

  /* ---------- 좌표 변환 ---------- */

  viewScale() {
    return this.el.getBoundingClientRect().width / CANVAS.w;
  }

  toCanvas(ev) {
    const r = this.el.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * CANVAS.w,
      y: ((ev.clientY - r.top) / r.height) * CANVAS.h,
    };
  }

  /* ---------- 히트 테스트 ---------- */

  /** 선택 대상의 화면 사각형(중심·크기·각도). */
  boundsOf(sel) {
    if (!sel) return null;
    if (sel.type === 'text') {
      const ts = this.state.texts[sel.key];
      const b = textBox(sel.key, ts);
      return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, angle: 0 };
    }
    const p = this.state.slots[sel.key];
    const asset = getAsset(p?.asset);
    if (!asset) {
      const r = SLOT_MAP[sel.key].rect;
      return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, angle: 0 };
    }
    return {
      cx: p.x, cy: p.y,
      w: asset.width * p.scale, h: asset.height * p.scale,
      angle: p.angle || 0,
    };
  }

  cornerPoints(b) {
    const rad = (b.angle * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return CORNERS.map(([sx, sy]) => {
      const x = (sx * b.w) / 2, y = (sy * b.h) / 2;
      return { x: b.cx + x * cos - y * sin, y: b.cy + x * sin + y * cos, sx, sy };
    });
  }

  sidePoints(b) {
    const rad = (b.angle * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return [-1, 1].map((sx) => {
      const x = (sx * b.w) / 2, y = 0;
      return { x: b.cx + x * cos - y * sin, y: b.cy + x * sin + y * cos, sx };
    });
  }

  rotatePoint(b) {
    const rad = (b.angle * Math.PI) / 180;
    const arm = b.h / 2 + ROTATE_ARM / this.viewScale();
    return { x: b.cx + arm * Math.sin(rad), y: b.cy - arm * Math.cos(rad) };
  }

  hitHandle(pt) {
    if (!this.selection) return null;
    const b = this.boundsOf(this.selection);
    if (!b) return null;
    const slop = HIT_SLOP / this.viewScale();

    const rp = this.rotatePoint(b);
    if (this.selection.type === 'slot' && Math.hypot(pt.x - rp.x, pt.y - rp.y) < slop) {
      return { kind: 'rotate' };
    }
    for (const c of this.cornerPoints(b)) {
      if (Math.hypot(pt.x - c.x, pt.y - c.y) < slop) return { kind: 'corner', sx: c.sx, sy: c.sy };
    }
    if (this.selection.type === 'text') {
      for (const s of this.sidePoints(b)) {
        if (Math.hypot(pt.x - s.x, pt.y - s.y) < slop) return { kind: 'side', sx: s.sx };
      }
    }
    return null;
  }

  /**
   * 문구를 상자가 아니라 '실제로 글자가 그려진 자리'로 판정한다.
   *
   * 상자 전체로 잡으면 좌상단 문구 상자(215×330)가 말풍선 슬롯 왼쪽 끝을 덮어
   * 그 띠에서는 사진을 고를 수 없고, 여백을 눌러 선택을 풀 수도 없다.
   * 렌더러와 같은 방식으로 줄을 나눠 각 줄의 실제 폭과 비교한다.
   */
  textHit(pt, key) {
    const st = this.state;
    const ts = st.texts[key];
    if (!ts || !ts.text.trim()) return false;

    const box = textBox(key, ts);
    const size = ts.auto
      ? fitSize(measure, ts.text, st.font, box, LIMITS.minFontSize, LIMITS.maxFontSize)
      : ts.size;
    const m = wrap(measure, ts.text, size, st.font, box.w);

    const top = box.y + Math.max(0, (box.h - m.height) / 2);
    if (pt.y < top - TEXT_PAD || pt.y > top + m.height + TEXT_PAD) return false;

    const row = Math.min(m.lines.length - 1, Math.max(0, Math.floor((pt.y - top) / m.lineHeight)));
    measure.font = fontSpec(size, st.font);
    const halfWidth = measure.measureText(m.lines[row]).width / 2;
    return Math.abs(pt.x - (box.x + box.w / 2)) <= halfWidth + TEXT_PAD;
  }

  hitTarget(pt) {
    const inRect = (r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;

    // 이미 고른 문구는 상자 전체로 잡는다 — 옮기는 중에 손이 글자에서 벗어나도
    // 놓치지 않게. (Esc 나 빈 곳 클릭으로 언제든 풀 수 있다)
    const sel = this.selection;
    if (sel?.type === 'text' && this.state.texts[sel.key] &&
        inRect(textBox(sel.key, this.state.texts[sel.key]))) {
      return sel;
    }

    // 그리는 순서의 역순으로 검사한다.
    for (const t of [...TEXTS].reverse()) {
      if (this.textHit(pt, t.key)) return { type: 'text', key: t.key };
    }
    for (const key of ['logo', 'phone', 'bubble']) {
      if (inRect(SLOT_MAP[key].rect)) return { type: 'slot', key };
    }
    return null;
  }

  /* ---------- 이벤트 ---------- */

  _bind() {
    const el = this.el;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onUp(e));
    el.addEventListener('pointerleave', () => { this.hovered = null; this.hooks.onChange?.(); });
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('dblclick', (e) => this.onDoubleClick(e));
  }

  select(sel) {
    const same =
      (!sel && !this.selection) ||
      (sel && this.selection && sel.type === this.selection.type && sel.key === this.selection.key);
    if (same) return;
    this.selection = sel;
    this.hooks.onSelect?.(sel);
    this.hooks.onChange?.();
  }

  onDown(e) {
    this.el.setPointerCapture(e.pointerId);
    const pt = this.toCanvas(e);
    this.pointers.set(e.pointerId, pt);

    if (this.pointers.size === 2 && this.selection?.type === 'slot') {
      const [a, b] = [...this.pointers.values()];
      const p = this.state.slots[this.selection.key];
      if (p) {
        this.mode = 'pinch';
        this.pinchStart = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          scale: p.scale, rot: p.angle || 0, x: p.x, y: p.y,
        };
      }
      return;
    }

    const handle = this.hitHandle(pt);
    if (handle) {
      const b = this.boundsOf(this.selection);
      this.mode = handle.kind;
      this.grab = {
        handle, start: pt, bounds: b,
        snapshot: JSON.parse(JSON.stringify(
          this.selection.type === 'slot'
            ? this.state.slots[this.selection.key]
            : this.state.texts[this.selection.key],
        )),
      };
      return;
    }

    const target = this.hitTarget(pt);
    this.select(target);

    if (!target) { this.mode = null; return; }

    if (target.type === 'slot' && !this.state.slots[target.key]) {
      // 빈 구멍을 누르면 바로 사진 고르기
      this.mode = null;
      this.hooks.onRequestUpload?.(target.key);
      return;
    }

    this.mode = 'move';
    const cur = target.type === 'slot' ? this.state.slots[target.key] : this.state.texts[target.key];
    this.grab = {
      start: pt,
      origin: target.type === 'slot' ? { x: cur.x, y: cur.y } : { x: cur.dx || 0, y: cur.dy || 0 },
    };
  }

  onMove(e) {
    const pt = this.toCanvas(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pt);

    if (!this.mode) {
      const t = this.hitTarget(pt);
      const h = t && t.type === 'slot' && !this.state.slots[t.key] ? t.key : null;
      if (h !== this.hovered) { this.hovered = h; this.hooks.onChange?.(); }
      this.el.style.cursor = this.hitHandle(pt) ? 'grab' : t ? 'move' : 'default';
      return;
    }

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const s = this.pinchStart;
      const factor = dist / (s.dist || 1);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.editor.update((st) => {
        const p = st.slots[this.selection.key];
        p.scale = clamp(s.scale * factor, 0.02, 40);
        p.angle = normAngle(s.rot + (angle - s.angle));
        p.x = mid.x + (s.x - s.mid.x) * factor;
        p.y = mid.y + (s.y - s.mid.y) * factor;
      }, { coalesce: `pinch:${this.selection.key}` });
      this.hooks.onChange?.();
      return;
    }

    if (this.mode === 'move') {
      const dx = pt.x - this.grab.start.x;
      const dy = pt.y - this.grab.start.y;
      this.editor.update((st) => {
        if (this.selection.type === 'slot') {
          const p = st.slots[this.selection.key];
          p.x = this.grab.origin.x + dx;
          p.y = this.grab.origin.y + dy;
        } else {
          const t = st.texts[this.selection.key];
          t.dx = Math.round(this.grab.origin.x + dx);
          t.dy = Math.round(this.grab.origin.y + dy);
        }
      }, { coalesce: `move:${this.selection.key}` });
      this.hooks.onChange?.();
      return;
    }

    if (this.mode === 'corner') {
      const b = this.grab.bounds;
      const d0 = Math.hypot(this.grab.start.x - b.cx, this.grab.start.y - b.cy);
      const d1 = Math.hypot(pt.x - b.cx, pt.y - b.cy);
      const factor = d0 > 1 ? d1 / d0 : 1;
      this.editor.update((st) => {
        if (this.selection.type === 'slot') {
          st.slots[this.selection.key].scale = clamp(this.grab.snapshot.scale * factor, 0.02, 40);
        } else {
          const t = st.texts[this.selection.key];
          t.auto = false;
          t.size = Math.round(clamp(this.grab.snapshot.size * factor, LIMITS.minFontSize, LIMITS.maxFontSize));
        }
      }, { coalesce: `scale:${this.selection.key}` });
      this.hooks.onChange?.();
      return;
    }

    if (this.mode === 'side') {
      const b = this.grab.bounds;
      const half = Math.abs(pt.x - b.cx);
      this.editor.update((st) => {
        st.texts[this.selection.key].w = Math.round(clamp(half * 2, 40, CANVAS.w));
      }, { coalesce: `width:${this.selection.key}` });
      this.hooks.onChange?.();
      return;
    }

    if (this.mode === 'rotate') {
      const b = this.grab.bounds;
      const a0 = Math.atan2(this.grab.start.y - b.cy, this.grab.start.x - b.cx);
      const a1 = Math.atan2(pt.y - b.cy, pt.x - b.cx);
      let deg = this.grab.snapshot.angle + ((a1 - a0) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      this.editor.update((st) => {
        st.slots[this.selection.key].angle = normAngle(deg);
      }, { coalesce: `rotate:${this.selection.key}` });
      this.hooks.onChange?.();
    }
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2 && this.mode === 'pinch') this.mode = null;
    if (this.pointers.size === 0) {
      this.mode = null;
      this.editor.seal();
    }
    this.hooks.onChange?.();
  }

  onWheel(e) {
    const pt = this.toCanvas(e);
    const target = this.selection?.type === 'slot' ? this.selection : this.hitTarget(pt);
    if (!target || target.type !== 'slot' || !this.state.slots[target.key]) return;
    e.preventDefault();
    this.select(target);
    const factor = Math.pow(1.0015, -e.deltaY);
    this.editor.update((st) => {
      const p = st.slots[target.key];
      const next = clamp(p.scale * factor, 0.02, 40);
      const applied = next / p.scale;
      // 커서 아래 지점이 제자리에 있도록 위치를 보정한다.
      p.x = pt.x + (p.x - pt.x) * applied;
      p.y = pt.y + (p.y - pt.y) * applied;
      p.scale = next;
    }, { coalesce: `wheel:${target.key}` });
    this.hooks.onChange?.();
  }

  onDoubleClick(e) {
    const pt = this.toCanvas(e);
    const t = this.hitTarget(pt);
    if (t?.type === 'text') {
      this.select(t);
      this.hooks.onEditText?.(t.key);
    } else if (t?.type === 'slot') {
      this.select(t);
      this.hooks.onRequestUpload?.(t.key);
    }
  }

  /* ---------- 핸들 그리기 ---------- */

  paint() {
    const el = this.el;
    const rect = el.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }

    const ctx = el.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!this.selection) return;

    const b = this.boundsOf(this.selection);
    if (!b) return;
    const vs = rect.width / CANVAS.w;
    const S = (p) => ({ x: p.x * vs, y: p.y * vs });

    const corners = this.cornerPoints(b).map(S);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(70,216,232,0.95)';
    ctx.beginPath();
    corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();

    if (this.selection.type === 'slot') {
      const rp = S(this.rotatePoint(b));
      const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
      ctx.beginPath();
      ctx.moveTo(topMid.x, topMid.y);
      ctx.lineTo(rp.x, rp.y);
      ctx.stroke();
      dot(ctx, rp.x, rp.y, HANDLE - 1);
    }

    for (const c of corners) dot(ctx, c.x, c.y, HANDLE);
    if (this.selection.type === 'text') {
      for (const s of this.sidePoints(b).map(S)) dot(ctx, s.x, s.y, HANDLE - 2);
    }

    // 조작 중에만 뜨는 수치 표시
    if (this.mode && this.mode !== 'move') {
      const label = this.readout();
      if (label) {
        const p = S({ x: b.cx, y: b.cy - b.h / 2 });
        chip(ctx, p.x, p.y - 26, label);
      }
    }
  }

  readout() {
    if (!this.selection) return '';
    if (this.selection.type === 'slot') {
      const p = this.state.slots[this.selection.key];
      if (!p) return '';
      const asset = getAsset(p.asset);
      const pct = Math.round(p.scale * 100);
      const deg = Math.round(p.angle || 0);
      const dims = asset ? `${Math.round(asset.width * p.scale)}×${Math.round(asset.height * p.scale)}` : '';
      return `${pct}%  ·  ${deg}°  ·  ${dims}`;
    }
    const t = this.state.texts[this.selection.key];
    return `${Math.round(t.size)}pt  ·  폭 ${Math.round(t.w)}`;
  }
}

function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r / 2 + 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#0d1017';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#46d8e8';
  ctx.fill();
}

function chip(ctx, x, y, text) {
  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  const w = ctx.measureText(text).width + 18;
  const h = 24;
  const rx = x - w / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(rx, y - h / 2, w, h, 6);
  else ctx.rect(rx, y - h / 2, w, h);
  ctx.fillStyle = 'rgba(13,16,23,0.94)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(70,216,232,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#d8f6fa';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function normAngle(d) { let a = d % 360; if (a < 0) a += 360; return Math.round(a * 10) / 10; }
