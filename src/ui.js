// 인스펙터 패널. 선택한 대상의 컨트롤만 보여주는 게 원칙 —
// 원본 에디터처럼 아코디언 6개를 늘어놓고 뒤지게 하지 않는다.

import { SLOTS, SLOT_MAP, TEXTS, TEXT_MAP, LIMITS } from './config.js';
import { getAsset } from './assets.js';
import { planExport, sceneTiming, videoSupport, formatBytes } from './exporter.js';

const $ = (id) => document.getElementById(id);

export function toast(message, kind = '') {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, kind === 'bad' ? 5200 : 3200);
}

export class UI {
  /**
   * @param {Editor} editor
   * @param {object} hooks
   */
  constructor(editor, hooks) {
    this.editor = editor;
    this.hooks = hooks;
    this.selection = null;
    this.syncing = false;
    this._buildLists();
    this._bind();
  }

  get state() { return this.editor.state; }

  /* ---------- 목록 (선택 없음 화면) ---------- */

  _buildLists() {
    const slotList = $('slot-list');
    for (const slot of SLOTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item';
      b.dataset.slot = slot.key;
      b.innerHTML = `<span class="item-dot"></span><span class="item-body">
        <span class="item-name">${slot.label}</span>
        <span class="item-sub" data-sub></span></span>`;
      b.addEventListener('click', () => {
        if (this.state.slots[slot.key]) this.hooks.onSelect({ type: 'slot', key: slot.key });
        else this.hooks.onRequestUpload(slot.key);
      });
      slotList.appendChild(b);
    }

    const textList = $('text-list');
    for (const t of TEXTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item';
      b.dataset.text = t.key;
      b.innerHTML = `<span class="item-dot"></span><span class="item-body">
        <span class="item-name">${t.label}</span>
        <span class="item-sub" data-sub></span></span>`;
      b.addEventListener('click', () => this.hooks.onSelect({ type: 'text', key: t.key }));
      textList.appendChild(b);
    }
  }

  /* ---------- 바인딩 ---------- */

  _bind() {
    for (const el of document.querySelectorAll('[data-deselect]')) {
      el.addEventListener('click', () => this.hooks.onSelect(null));
    }

    // 사진 슬롯
    const slotKey = () => (this.selection?.type === 'slot' ? this.selection.key : null);
    const textKey = () => (this.selection?.type === 'text' ? this.selection.key : null);

    $('slot-replace').addEventListener('click', () => { const k = slotKey(); if (k) this.hooks.onRequestUpload(k); });
    $('slot-remove').addEventListener('click', () => { const k = slotKey(); if (k) this.hooks.onRemoveSlot(k); });
    $('slot-rot90').addEventListener('click', () => {
      const k = slotKey(); if (!k) return;
      this.editor.update((s) => {
        const p = s.slots[k];
        if (p) p.angle = Math.round(((p.angle || 0) + 90) % 360);
      });
      this.hooks.onDirty();
    });
    $('slot-flip').addEventListener('click', () => {
      const k = slotKey(); if (!k) return;
      this.editor.update((s) => { const p = s.slots[k]; if (p) p.flip = !p.flip; });
      this.hooks.onDirty();
    });
    $('slot-fit').addEventListener('click', () => { const k = slotKey(); if (k) this.hooks.onFitSlot(k); });

    this._slider('slot-scale', (v) => {
      const k = slotKey(); if (!k || !this.state.slots[k]) return;
      this.editor.update((s) => { s.slots[k].scale = v / 100; }, { coalesce: `ui-scale:${k}` });
    });
    this._slider('slot-angle', (v) => {
      const k = slotKey(); if (!k || !this.state.slots[k]) return;
      this.editor.update((s) => { s.slots[k].angle = v; }, { coalesce: `ui-angle:${k}` });
    });

    // 로고 효과
    this._toggle('fx-outline', 'fx-outline-body', (on) => {
      this.editor.update((s) => { s.effects.outline.on = on; });
    });
    this._slider('fx-outline-w', (v) => {
      this.editor.update((s) => { s.effects.outline.width = v; }, { coalesce: 'fx-ow' });
    });
    this._color('fx-outline-color', (v) => {
      this.editor.update((s) => { s.effects.outline.color = v; }, { coalesce: 'fx-oc' });
    });

    this._toggle('fx-shadow', 'fx-shadow-body', (on) => {
      this.editor.update((s) => { s.effects.shadow.on = on; });
    });
    this._slider('fx-shadow-blur', (v) => {
      this.editor.update((s) => { s.effects.shadow.blur = v; }, { coalesce: 'fx-sb' });
    });
    this._slider('fx-shadow-dx', (v) => {
      this.editor.update((s) => { s.effects.shadow.dx = v; }, { coalesce: 'fx-sx' });
    });
    this._slider('fx-shadow-dy', (v) => {
      this.editor.update((s) => { s.effects.shadow.dy = v; }, { coalesce: 'fx-sy' });
    });
    this._color('fx-shadow-color', (v) => {
      this.editor.update((s) => { s.effects.shadow.color = v; }, { coalesce: 'fx-sc' });
    });

    // 문구
    $('text-edit').addEventListener('click', () => { const k = textKey(); if (k) this.hooks.onEditText(k); });
    $('text-auto').addEventListener('change', (e) => {
      const k = textKey(); if (!k) return;
      this.editor.update((s) => { s.texts[k].auto = e.target.checked; });
      this.sync();
      this.hooks.onDirty();
    });
    this._slider('text-size', (v) => {
      const k = textKey(); if (!k) return;
      this.editor.update((s) => { s.texts[k].size = v; s.texts[k].auto = false; }, { coalesce: `ui-size:${k}` });
    });
    this._slider('text-width', (v) => {
      const k = textKey(); if (!k) return;
      this.editor.update((s) => { s.texts[k].w = v; }, { coalesce: `ui-width:${k}` });
    });
    this._color('text-color', (v) => {
      const k = textKey(); if (!k) return;
      this.editor.update((s) => { s.texts[k].color = v; }, { coalesce: `ui-color:${k}` });
    });
    $('text-reset').addEventListener('click', () => {
      const key = textKey(); if (!key) return;
      const def = TEXT_MAP[key];
      this.editor.update((s) => {
        Object.assign(s.texts[key], { dx: 0, dy: 0, w: def.box.w, size: def.size, auto: false });
      });
      this.sync();
      this.hooks.onDirty();
    });

    // 도구
    $('sgdb-go').addEventListener('click', () => this.hooks.onSearch($('sgdb-input').value));
    $('sgdb-input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.hooks.onSearch(e.target.value); }
    });
    $('font-pick').addEventListener('click', () => $('font-input').click());
  }

  _slider(id, apply) {
    const el = $(id);
    const label = $(`${id}-val`);
    el.addEventListener('input', () => {
      if (this.syncing) return;
      const v = parseFloat(el.value);
      if (label) label.textContent = formatVal(id, v);
      apply(v);
      this.hooks.onDirty();
    });
    el.addEventListener('change', () => this.editor.seal());
  }

  _color(id, apply) {
    const el = $(id);
    el.addEventListener('input', () => {
      if (this.syncing) return;
      apply(el.value);
      this.hooks.onDirty();
    });
    el.addEventListener('change', () => this.editor.seal());
  }

  _toggle(id, bodyId, apply) {
    const el = $(id);
    el.addEventListener('change', () => {
      if (this.syncing) return;
      $(bodyId).hidden = !el.checked;
      apply(el.checked);
      this.hooks.onDirty();
    });
  }

  /* ---------- 화면 갱신 ---------- */

  setSelection(sel) {
    this.selection = sel;
    $('insp-none').hidden = !!sel;
    $('insp-slot').hidden = sel?.type !== 'slot';
    $('insp-text').hidden = sel?.type !== 'text';
    this.sync();
  }

  sync() {
    this.syncing = true;
    try { this._sync(); } finally { this.syncing = false; }
  }

  _sync() {
    const st = this.state;

    // 목록
    for (const slot of SLOTS) {
      const btn = document.querySelector(`[data-slot="${slot.key}"]`);
      const p = st.slots[slot.key];
      const asset = getAsset(p?.asset);
      btn.classList.toggle('filled', !!asset);
      btn.querySelector('[data-sub]').textContent = asset
        ? `${asset.kind === 'gif' ? `움짤 ${asset.frames.length}장` : '사진'} · ${asset.width}×${asset.height}`
        : '비어 있음 — 눌러서 넣기';
    }
    for (const t of TEXTS) {
      const btn = document.querySelector(`[data-text="${t.key}"]`);
      const ts = st.texts[t.key];
      btn.classList.toggle('filled', !!ts.text.trim());
      btn.querySelector('[data-sub]').textContent = ts.text.trim()
        ? ts.text.replace(/\s+/g, ' ').slice(0, 30)
        : '비어 있음';
    }

    // 소스 정보
    const gifs = SLOTS
      .map((s) => ({ label: s.label, asset: getAsset(st.slots[s.key]?.asset) }))
      .filter((x) => x.asset?.kind === 'gif');
    const info = $('source-info');
    if (gifs.length) {
      info.hidden = false;
      info.innerHTML = gifs.map((g) => {
        const fps = g.asset.duration ? (g.asset.frames.length / (g.asset.duration / 1000)).toFixed(1) : '—';
        return `${g.label} · ${g.asset.frames.length}장 · ${fps} fps · ${(g.asset.duration / 1000).toFixed(2)}초`;
      }).join('<br>');
    } else {
      info.hidden = true;
    }

    if (this.selection?.type === 'slot') this._syncSlot();
    if (this.selection?.type === 'text') this._syncText();
  }

  _syncSlot() {
    const key = this.selection.key;
    const p = this.state.slots[key];
    $('slot-title').textContent = SLOT_MAP[key].label;
    $('logo-effects').hidden = key !== 'logo';

    if (!p) return;
    const asset = getAsset(p.asset);
    setSlider('slot-scale', Math.round(p.scale * 100));
    setSlider('slot-angle', Math.round(p.angle || 0));
    $('slot-meta').innerHTML = asset
      ? `원본 ${asset.width}×${asset.height} · 화면 ${Math.round(asset.width * p.scale)}×${Math.round(asset.height * p.scale)}`
        + (asset.kind === 'gif' ? `<br>움짤 ${asset.frames.length}장 · ${(asset.duration / 1000).toFixed(2)}초` : '')
        + (p.flip ? '<br>좌우 뒤집힘' : '')
      : '';

    const fx = this.state.effects;
    $('fx-outline').checked = fx.outline.on;
    $('fx-outline-body').hidden = !fx.outline.on;
    setSlider('fx-outline-w', fx.outline.width);
    $('fx-outline-color').value = fx.outline.color;
    $('fx-shadow').checked = fx.shadow.on;
    $('fx-shadow-body').hidden = !fx.shadow.on;
    setSlider('fx-shadow-blur', fx.shadow.blur);
    setSlider('fx-shadow-dx', fx.shadow.dx);
    setSlider('fx-shadow-dy', fx.shadow.dy);
    $('fx-shadow-color').value = fx.shadow.color;
  }

  _syncText() {
    const key = this.selection.key;
    const ts = this.state.texts[key];
    $('text-title').textContent = TEXT_MAP[key].label;
    $('text-auto').checked = !!ts.auto;
    $('text-size-field').style.opacity = ts.auto ? '.45' : '1';
    $('text-size').disabled = !!ts.auto;
    setSlider('text-size', Math.round(ts.size));
    setSlider('text-width', Math.round(ts.w));
    $('text-color').value = ts.color || '#000000';
    const moved = ts.dx || ts.dy;
    $('text-meta').textContent = moved ? `기본 위치에서 ${Math.round(ts.dx)}, ${Math.round(ts.dy)} 만큼 옮김` : '';
  }

  setHistory({ canUndo, canRedo }) {
    $('btn-undo').disabled = !canUndo;
    $('btn-redo').disabled = !canRedo;
  }

  setStatus(text) {
    $('bar-status').textContent = text;
  }

  setFontName(name) {
    $('font-meta').textContent = name;
  }
}

function setSlider(id, v) {
  const el = $(id);
  if (el) el.value = v;
  const label = $(`${id}-val`);
  if (label) label.textContent = formatVal(id, v);
}

function formatVal(id, v) {
  if (id === 'slot-scale') return `${Math.round(v)}%`;
  if (id === 'slot-angle') return `${Math.round(v)}°`;
  if (id === 'fx-outline-w') return Number(v).toFixed(1);
  return String(Math.round(v));
}

/* ---------- 내보내기 대화상자 ---------- */

export class ExportDialog {
  constructor(editor, hooks) {
    this.editor = editor;
    this.hooks = hooks;
    this.format = 'gif';
    this.busy = false;
    this.cancelled = false;
    this.dlg = $('export-dialog');

    for (const b of document.querySelectorAll('.seg-btn')) {
      b.addEventListener('click', () => {
        if (b.disabled) return;
        this.format = b.dataset.fmt;
        for (const o of document.querySelectorAll('.seg-btn')) o.classList.toggle('is-on', o === b);
        this.refresh();
      });
    }
    for (const id of ['ex-scale', 'ex-fps', 'ex-speed', 'ex-colors']) {
      $(id).addEventListener('change', () => this.refresh());
    }
    $('ex-cancel').addEventListener('click', () => {
      if (this.busy) { this.cancelled = true; return; }
      this.dlg.close();
    });
    $('ex-run').addEventListener('click', () => this.run());
    this.dlg.addEventListener('cancel', (e) => { if (this.busy) { e.preventDefault(); this.cancelled = true; } });
  }

  options() {
    return {
      scale: parseFloat($('ex-scale').value),
      fps: parseInt($('ex-fps').value, 10),
      speed: parseFloat($('ex-speed').value),
      colors: parseInt($('ex-colors').value, 10),
    };
  }

  open() {
    const t = sceneTiming(this.editor.state);
    const vid = videoSupport();
    for (const b of document.querySelectorAll('.seg-btn')) {
      const f = b.dataset.fmt;
      b.disabled = (f === 'gif' || f === 'video') ? !t.animated : false;
      if (f === 'video' && !vid) b.disabled = true;
    }
    if (!t.animated) this.format = 'png';
    else if (this.format === 'video' && !vid) this.format = 'gif';
    for (const b of document.querySelectorAll('.seg-btn')) b.classList.toggle('is-on', b.dataset.fmt === this.format);

    $('ex-progress').hidden = true;
    this.busy = false;
    this.cancelled = false;
    $('ex-cancel').textContent = '닫기';
    $('ex-run').disabled = false;
    this.refresh();
    this.dlg.showModal();
  }

  refresh() {
    const animated = sceneTiming(this.editor.state).animated;
    const isMotion = this.format !== 'png';
    $('motion-fields').hidden = !isMotion;
    $('ex-colors-field').hidden = this.format !== 'gif';

    const o = this.options();
    const plan = planExport(this.editor.state, o);
    const box = $('ex-estimate');

    if (this.format === 'png') {
      box.innerHTML = `${plan.width}×${plan.height} PNG 한 장`;
      return;
    }
    if (!animated) {
      box.innerHTML = '<span class="warn">움직이는 사진이 없습니다. PNG로 저장하세요.</span>';
      return;
    }

    const lines = [
      `${plan.width}×${plan.height} · ${plan.frames}프레임 · ${plan.fps}fps · ${(plan.duration / 1000).toFixed(2)}초`,
    ];
    if (plan.capped) {
      lines.push(`<span class="warn">프레임 상한(${LIMITS.maxExportFrames}장) 때문에 초당 ${plan.fps}장으로 낮췄습니다. 길이는 그대로입니다.</span>`);
    }
    if (this.format === 'gif') {
      const heavy = plan.frames * plan.width * plan.height;
      if (heavy > 220_000_000) lines.push('<span class="warn">용량이 커서 시간이 꽤 걸립니다. 크기나 프레임을 줄이는 편이 낫습니다.</span>');
    } else {
      lines.push(`영상은 실시간으로 녹화하므로 약 ${(plan.duration / 1000).toFixed(1)}초 걸립니다.`);
    }
    box.innerHTML = lines.join('<br>');
  }

  async run() {
    if (this.busy) return;
    this.busy = true;
    this.cancelled = false;
    $('ex-run').disabled = true;
    $('ex-cancel').textContent = '중단';
    $('ex-progress').hidden = false;
    this.setProgress(0, '준비 중');

    try {
      const result = await this.hooks.onRun(this.format, this.options(), {
        onProgress: ({ phase, ratio, detail }) => {
          const label = phase === 'palette' ? '색 고르는 중' : phase === 'record' ? '녹화 중' : '압축 중';
          this.setProgress(phase === 'palette' ? ratio * 0.15 : 0.15 + ratio * 0.85, detail || label);
        },
        isCancelled: () => this.cancelled,
      });
      if (this.cancelled || !result) {
        toast('내보내기를 중단했습니다.');
      } else {
        toast(`저장했습니다 · ${formatBytes(result.size)}`);
        this.dlg.close();
      }
    } catch (err) {
      toast(err.message || '내보내기에 실패했습니다.', 'bad');
    } finally {
      this.busy = false;
      $('ex-run').disabled = false;
      $('ex-cancel').textContent = '닫기';
      $('ex-progress').hidden = true;
    }
  }

  setProgress(ratio, text) {
    $('ex-progress-fill').style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    $('ex-progress-text').textContent = text;
  }
}
