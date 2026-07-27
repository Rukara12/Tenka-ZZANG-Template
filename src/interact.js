// 포인터 기반 직접 조작.
// 마우스와 터치를 Pointer Events 하나로 처리하므로 모바일에서 핀치 확대·회전이 그냥 된다.

import { CANVAS, SLOT_MAP, TEXTS, TEXT_MAP, LIMITS, MIN_TEXT_BOX, guideBandRect } from './config.js';
import { getAsset } from './assets.js';
import { insideHole, holeMaskReady } from './mask.js';
import { textBox, fitTextSize } from './renderer.js';
import { wrap, fontSpec } from './text.js';

const HANDLE = 9;       // 핸들 반지름(화면 px)
const HIT_SLOP = 14;    // 핸들 판정 여유
const ROTATE_ARM = 30;  // 회전 핸들이 상자 위로 떨어진 거리
const EDGE_PAD = 18;    // 핸들을 화면 안쪽으로 붙여 두는 여유(화면 px)

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

  /**
   * 핸들을 화면 안으로 끌어들인다.
   *
   * 핸들은 사진의 바깥 테두리에 붙어 있는데, 사진을 확대하면 그 테두리가 캔버스
   * 밖으로 나가 버려서 잡을 방법이 사라진다(휠과 슬라이더만 남는다). 크기 조절은
   * 포인터가 중심에서 멀어진 '비율'로 계산하므로, 핸들을 화면 안으로 당겨 놔도
   * 조작 결과는 달라지지 않는다.
   */
  clampPoints(points) {
    const pad = EDGE_PAD / this.viewScale();
    let clamped = false;
    const out = points.map((p) => {
      const x = Math.min(CANVAS.w - pad, Math.max(pad, p.x));
      const y = Math.min(CANVAS.h - pad, Math.max(pad, p.y));
      if (x !== p.x || y !== p.y) clamped = true;
      return { ...p, x, y };
    });
    out.clamped = clamped;
    return out;
  }

  cornerPoints(b) {
    const rad = (b.angle * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return CORNERS.map(([sx, sy]) => {
      const x = (sx * b.w) / 2, y = (sy * b.h) / 2;
      return { x: b.cx + x * cos - y * sin, y: b.cy + x * sin + y * cos, sx, sy };
    });
  }

  /** 네 변의 한가운데 — 좌우는 너비, 위아래는 높이를 바꾼다. */
  sidePoints(b) {
    const rad = (b.angle * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([sx, sy]) => {
      const x = (sx * b.w) / 2, y = (sy * b.h) / 2;
      return { x: b.cx + x * cos - y * sin, y: b.cy + x * sin + y * cos, sx, sy };
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

    // 그려지는 자리와 판정하는 자리가 같아야 하므로 똑같이 당겨서 쓴다.
    const [rp] = this.clampPoints([this.rotatePoint(b)]);
    if (this.selection.type === 'slot' && Math.hypot(pt.x - rp.x, pt.y - rp.y) < slop) {
      return { kind: 'rotate' };
    }
    for (const c of this.clampPoints(this.cornerPoints(b))) {
      if (Math.hypot(pt.x - c.x, pt.y - c.y) < slop) return { kind: 'corner', sx: c.sx, sy: c.sy };
    }
    if (this.selection.type === 'text') {
      for (const s of this.clampPoints(this.sidePoints(b))) {
        if (Math.hypot(pt.x - s.x, pt.y - s.y) < slop) return { kind: 'side', sx: s.sx, sy: s.sy };
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
    const size = ts.auto ? fitTextSize(measure, key, st) : ts.size;
    const m = wrap(measure, ts.text, size, st.font, box.w);

    const top = box.y + Math.max(0, (box.h - m.height) / 2);
    if (pt.y < top - TEXT_PAD || pt.y > top + m.height + TEXT_PAD) return false;

    const row = Math.min(m.lines.length - 1, Math.max(0, Math.floor((pt.y - top) / m.lineHeight)));
    measure.font = fontSpec(size, st.font);
    const halfWidth = measure.measureText(m.lines[row]).width / 2;
    return Math.abs(pt.x - (box.x + box.w / 2)) <= halfWidth + TEXT_PAD;
  }

  /**
   * 손잡이마다 방향에 맞는 커서를 준다. 무엇을 잡으면 무엇이 되는지 커서로 미리
   * 알려주는 게 '익숙한 편집기' 느낌의 절반이다. 회전된 사진이면 커서도 같이 돈다.
   */
  cursorFor(handle, target) {
    if (!handle) return target ? 'move' : 'default';
    if (handle.kind === 'rotate') return 'grab';

    const b = this.boundsOf(this.selection);
    if (!b) return 'grab';

    // 손잡이가 중심에서 뻗은 방향(도) — 회전을 포함한 실제 화면상의 방향
    const local = Math.atan2(handle.sy * b.h, handle.sx * b.w);
    const deg = (local * 180) / Math.PI + (b.angle || 0);
    const a = ((deg % 180) + 180) % 180;

    if (a < 22.5 || a >= 157.5) return 'ew-resize';
    if (a < 67.5) return 'nwse-resize';
    if (a < 112.5) return 'ns-resize';
    return 'nesw-resize';
  }

  /**
   * 이 점이 그 칸을 누른 것으로 볼 것인가.
   *
   * 구멍 칸(말풍선·핸드폰)은 사각형 전체다 — 구멍이 곧 보이는 자리라 헷갈릴 게 없다.
   * 반면 above 칸(로고)의 사각형은 캐릭터를 통째로 덮을 만큼 넓어서, 그 안 아무 데나
   * 눌러도 로고가 잡히면 밑에 있는 것들을 건드릴 수가 없다. 그래서
   *   비어 있을 때 — 안내 띠만
   *   채워져 있을 때 — 실제 로고 그림 위만
   * 을 누른 것으로 친다.
   */
  slotHit(pt, key) {
    const slot = SLOT_MAP[key];
    const r = slot.rect;
    const inRect = pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
    if (!slot.above) {
      // 구멍 모양 그대로 — 사각형은 구멍보다 훨씬 넓어서 말풍선 바깥을 눌러도
      // 말풍선이 잡혀 버린다.
      return holeMaskReady() ? insideHole(key, pt.x, pt.y) : inRect;
    }

    const p = this.state.slots[key];
    if (!p) {
      const b = guideBandRect(key);
      return pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h;
    }
    if (!inRect) return false; // 칸 밖은 어차피 잘려서 안 보인다

    const asset = getAsset(p.asset);
    if (!asset) return false;
    // 회전을 걷어낸 좌표에서 그림 사각형 안인지 본다
    const rad = ((p.angle || 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = pt.x - p.x, dy = pt.y - p.y;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return Math.abs(lx) <= (asset.width * p.scale) / 2
        && Math.abs(ly) <= (asset.height * p.scale) / 2;
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
      if (this.slotHit(pt, key)) return { type: 'slot', key };
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

      // 모서리를 잡으면 '반대쪽 모서리'를 못으로 박아 둔다. 파워포인트를 비롯한
      // 대부분의 편집기가 이렇게 동작한다 — 잡은 곳만 따라오고 나머지는 제자리.
      // 예전에는 중심을 기준으로 양쪽이 같이 늘어나서 손이 예상한 곳으로 가지 않았다.
      if (handle.kind === 'corner') {
        const rad = (b.angle * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const hx = (handle.sx * b.w) / 2;
        const hy = (handle.sy * b.h) / 2;
        this.grab.anchor = {
          x: b.cx - (hx * cos - hy * sin),
          y: b.cy - (hx * sin + hy * cos),
        };
        // 회전을 걷어낸 좌표계에서 '고정점 → 잡은 모서리' 벡터
        this.grab.diag = { x: handle.sx * b.w, y: handle.sy * b.h };
        this.grab.cos = cos;
        this.grab.sin = sin;
      }
      return;
    }

    const target = this.hitTarget(pt);

    if (target?.type === 'slot' && !this.state.slots[target.key]) {
      // 빈 구멍을 누르면 바로 사진 고르기.
      // 고르지는 않는다 — 빈 칸을 선택해 봐야 손잡이만 뜨고, 그 손잡이는 구멍이
      // 아니라 넉넉한 사각형을 두르고 있어서 없는 경계를 있는 것처럼 보여준다.
      this.mode = null;
      this.select(null);
      this.hooks.onRequestUpload?.(target.key);
      return;
    }

    this.select(target);
    if (!target) { this.mode = null; return; }

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
      this.el.style.cursor = this.cursorFor(this.hitHandle(pt), t);
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
        p.scale = clamp(s.scale * factor, LIMITS.minScale, LIMITS.maxScale);
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
      const g = this.grab;
      const b = g.bounds;

      // Ctrl(⌘)을 누르고 있으면 가운데를 기준으로 — 파워포인트와 같은 보조키.
      const fromCenter = e.ctrlKey || e.metaKey;

      let factor;
      if (fromCenter || !g.anchor) {
        const d0 = Math.hypot(g.start.x - b.cx, g.start.y - b.cy);
        const d1 = Math.hypot(pt.x - b.cx, pt.y - b.cy);
        factor = d0 > 1 ? d1 / d0 : 1;
      } else {
        // 고정점 기준 포인터 위치를 회전 없는 좌표계로 되돌린 뒤,
        // 원래 대각선 벡터에 정사영해서 배율을 얻는다. 가로세로 비가 늘 유지된다.
        const dx = pt.x - g.anchor.x;
        const dy = pt.y - g.anchor.y;
        const lx = dx * g.cos + dy * g.sin;
        const ly = -dx * g.sin + dy * g.cos;
        const dd = g.diag.x * g.diag.x + g.diag.y * g.diag.y;
        factor = dd > 0 ? (lx * g.diag.x + ly * g.diag.y) / dd : 1;
      }
      factor = Math.max(0.01, factor);

      this.editor.update((st) => {
        if (this.selection.type === 'slot') {
          const p = st.slots[this.selection.key];
          const next = clamp(g.snapshot.scale * factor, LIMITS.minScale, LIMITS.maxScale);
          p.scale = next;
          if (!fromCenter && g.anchor) {
            // 실제로 적용된 배율(한계에 걸렸을 수 있다)로 중심을 다시 잡아
            // 고정점이 정확히 제자리에 남게 한다.
            const f = next / g.snapshot.scale;
            const hx = (g.diag.x / 2) * f;
            const hy = (g.diag.y / 2) * f;
            p.x = g.anchor.x + (hx * g.cos - hy * g.sin);
            p.y = g.anchor.y + (hx * g.sin + hy * g.cos);
          }
        } else {
          // 문구는 상자와 글자 크기가 함께 커져야 잡은 모서리가 포인터를 따라온다.
          // 예전에는 글자 크기만 바뀌고 상자는 가만히 있어서, 끌어도 모서리가
          // 손을 따라오지 않았다.
          const key = this.selection.key;
          const t = st.texts[key];
          const base = TEXT_MAP[key].box;
          const sw = g.snapshot.w || base.w;
          const sh = g.snapshot.h || base.h;
          const ss = g.snapshot.size;

          // 셋 중 하나라도 한계에 걸리면 나머지도 같이 멈춰야 비율이 유지된다.
          const f = Math.max(
            Math.max(LIMITS.minFontSize / ss, MIN_TEXT_BOX / sw, MIN_TEXT_BOX / sh),
            Math.min(factor, LIMITS.maxFontSize / ss, CANVAS.w / sw, CANVAS.h / sh),
          );

          t.auto = false;
          t.size = Math.round(ss * f);
          t.w = Math.round(sw * f);
          t.h = Math.round(sh * f);

          if (!fromCenter && g.anchor) {
            const cx = g.anchor.x + (g.diag.x / 2) * f;
            const cy = g.anchor.y + (g.diag.y / 2) * f;
            t.dx = Math.round(cx - t.w / 2 - base.x);
            t.dy = Math.round(cy - t.h / 2 - base.y);
          }
        }
      }, { coalesce: `scale:${this.selection.key}` });
      this.hooks.onChange?.();
      return;
    }

    if (this.mode === 'side') {
      // 반대쪽 변을 고정하고 잡은 변만 끈다.
      const b = this.grab.bounds;
      const key = this.selection.key;
      const base = TEXT_MAP[key].box;
      const { sx, sy } = this.grab.handle;
      this.editor.update((st) => {
        const t = st.texts[key];
        if (sx) {
          const anchor = b.cx - (sx * b.w) / 2;
          const w = clamp(Math.abs(pt.x - anchor), MIN_TEXT_BOX, CANVAS.w);
          t.w = Math.round(w);
          t.dx = Math.round(anchor + (sx * w) / 2 - w / 2 - base.x);
        } else {
          const anchor = b.cy - (sy * b.h) / 2;
          const h = clamp(Math.abs(pt.y - anchor), MIN_TEXT_BOX, CANVAS.h);
          t.h = Math.round(h);
          t.dy = Math.round(anchor + (sy * h) / 2 - h / 2 - base.y);
        }
      }, { coalesce: `side:${key}` });
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
    // Ctrl+휠 과 트랙패드 핀치는 보기 배율 조절이다(main.js). 여기서 가로채면
    // 화면을 키우려는 손짓이 사진 크기 조절로 먹혀 버린다.
    if (e.ctrlKey || e.metaKey) return;

    const pt = this.toCanvas(e);
    const target = this.selection?.type === 'slot' ? this.selection : this.hitTarget(pt);
    if (!target || target.type !== 'slot' || !this.state.slots[target.key]) return;
    e.preventDefault();
    this.select(target);
    const factor = Math.pow(1.0015, -e.deltaY);
    this.editor.update((st) => {
      const p = st.slots[target.key];
      const next = clamp(p.scale * factor, LIMITS.minScale, LIMITS.maxScale);
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
      if (this.state.slots[t.key]) this.select(t);
      else this.select(null);
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

    const raw = this.clampPoints(this.cornerPoints(b));
    const corners = raw.map(S);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(70,216,232,0.95)';
    // 사진이 화면 밖까지 뻗어 있으면 테두리를 점선으로 — 실제 경계가 아님을 알린다.
    ctx.setLineDash(raw.clamped ? [6, 5] : []);
    ctx.beginPath();
    corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    if (this.selection.type === 'slot') {
      const rp = S(this.clampPoints([this.rotatePoint(b)])[0]);
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
    const base = TEXT_MAP[this.selection.key].box;
    return `${Math.round(t.size)}pt  ·  ${Math.round(t.w || base.w)}×${Math.round(t.h || base.h)}`;
  }
}

// 흰 알맹이에 진한 테두리 — 흔한 편집기의 손잡이 모양. 사진이 밝든 어둡든 보인다.
function dot(ctx, x, y, r) {
  const rad = r / 2 + 1.5;
  ctx.beginPath();
  ctx.arc(x, y, rad + 1.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(13,16,23,0.28)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#0f8fa0';
  ctx.stroke();
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
