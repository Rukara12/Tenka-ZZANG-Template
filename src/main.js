// 앱 조립.

import { CANVAS, SLOTS, SLOT_MAP, LINKS, BASE_FONT, defaultPlacement } from './config.js';
import { Editor } from './state.js';
import { store } from './store.js';
import { createAsset, restoreAsset, getAsset, frameIndexAt, disposeUnused } from './assets.js';
import { drawScene, clearOutlineCache } from './renderer.js';
import { measureHoles, visibleRect } from './mask.js';
import { Interactor } from './interact.js';
import { TextEditor } from './textedit.js';
import { UI, ExportDialog, toast } from './ui.js';
import { exportPng, exportGif, exportVideo, estimateGifSizes, measurePng } from './exporter.js';

const $ = (id) => document.getElementById(id);

const stage = $('stage');
const ctx = stage.getContext('2d');
const editor = new Editor();

let overlayImg = null;
let renderScale = 1;
let dirty = true;
let sceneTime = 0;
let lastTs = 0;
let lastSig = '';
let dim = 0;
let dimTarget = 0;
let uploadTarget = 'bubble';
let customFontSeq = 0;

/* ---------- 템플릿 그림 ---------- */

function loadOverlay() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'tenka.png';
  });
}

/* ---------- 측정용 컨텍스트 (레이아웃 계산 전용) ---------- */

const measure = document.createElement('canvas').getContext('2d');

/* ---------- 화면 크기와 보기 배율 ---------- */

// 예전에는 캔버스 폭을 CSS 의 shrink-to-fit 에 맡겼는데, 그 기준이 캔버스의 고유
// 픽셀 폭이라 1024 → 1024 로 스스로를 고정해 버렸다. 창이 아무리 커도 그대로였고,
// 세로 여유는 아예 계산에 들어가지 않았다. 이제 여기서 픽셀로 정해 준다.

const stageWrap = $('stage-wrap');
const stageArea = document.querySelector('.stage-area');
const stageTip = $('stage-tip');

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const MAX_RENDER_SCALE = 3; // 확대했을 때도 또렷하도록. 3배면 3072x2295.

let viewZoom = 0; // 0 이면 '맞춤'
let fitZoom = 1;

// 좁은 화면에서는 .layout 이 세로로 쌓이면서 .stage-area 높이가 '내용에 맞춤'이 된다.
// 그 높이로 배율을 계산하면 스스로를 물고 도는 순환이 되므로 가로만 본다.
const narrow = globalThis.matchMedia?.('(max-width: 860px)');

/** 지금 창에서 캔버스가 온전히 들어가는 최대 배율. 가로·세로를 모두 본다. */
function computeFit() {
  if (!stageArea) return 1;
  const cs = getComputedStyle(stageArea);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const gap = parseFloat(cs.rowGap) || 0;
  // 안내 문구는 좁은 화면에서 숨겨진다 — 보일 때만 자리를 뺀다.
  const tipH = stageTip && stageTip.offsetParent !== null ? stageTip.offsetHeight + gap : 0;

  const availW = stageArea.clientWidth - padX;
  if (!(availW > 0)) return fitZoom || 1;
  if (narrow?.matches) return Math.max(0.1, availW / CANVAS.w);

  const availH = stageArea.clientHeight - padY - tipH;
  if (!(availH > 0)) return Math.max(0.1, availW / CANVAS.w);
  return Math.max(0.1, Math.min(availW / CANVAS.w, availH / CANVAS.h));
}

function applyView() {
  fitZoom = computeFit();
  const z = viewZoom || fitZoom;

  // floor 로 깎는다. 반올림하면 '맞춤'일 때 폭이 남는 공간보다 0.5px 커질 수 있고,
  // 그 0.5px 때문에 가로 스크롤이 생겨 터치 화면이 좌우로 흔들린다.
  stageWrap.style.width = `${Math.max(200, Math.floor(CANVAS.w * z))}px`;

  // 표시 크기가 정해진 다음에 백업 캔버스 해상도를 맞춘다.
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const want = Math.min(MAX_RENDER_SCALE, Math.max(1, z * dpr));
  const next = Math.round(want * 4) / 4;
  if (next !== renderScale) {
    renderScale = next;
    stage.width = Math.round(CANVAS.w * renderScale);
    stage.height = Math.round(CANVAS.h * renderScale);
  }

  syncZoomUi(z);
  dirty = true;
  textEditor?.layout();
}

function resize() { applyView(); }

/**
 * @param {number} z 0 이면 맞춤
 * @param {{x:number,y:number}} [anchor] 확대 후에도 제자리에 둘 지점 (스테이지 안 0~1)
 */
function setZoom(z, anchor) {
  const prevW = stageWrap.offsetWidth;
  const prevH = stageWrap.offsetHeight;
  const sl = stageArea.scrollLeft;
  const st = stageArea.scrollTop;

  viewZoom = z ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : 0;
  applyView();

  if (anchor && prevW > 0) {
    stageArea.scrollLeft = sl + (stageWrap.offsetWidth - prevW) * anchor.x;
    stageArea.scrollTop = st + (stageWrap.offsetHeight - prevH) * anchor.y;
  }
}

function stepZoom(dir, anchor) {
  const cur = viewZoom || fitZoom;
  const next = dir > 0
    ? ZOOM_STEPS.find((s) => s > cur + 1e-4) ?? ZOOM_MAX
    : [...ZOOM_STEPS].reverse().find((s) => s < cur - 1e-4) ?? ZOOM_MIN;
  setZoom(next, anchor);
}

function syncZoomUi(z) {
  $('zoom-level').textContent = viewZoom ? `${Math.round(z * 100)}%` : '맞춤';
  $('zoom-out').disabled = z <= ZOOM_MIN + 1e-4;
  $('zoom-in').disabled = z >= ZOOM_MAX - 1e-4;
}

function anchorFrom(e) {
  const r = stageWrap.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
}

/* ---------- 렌더 루프 ---------- */

function frameSignature() {
  let s = '';
  for (const slot of SLOTS) {
    const a = getAsset(editor.state.slots[slot.key]?.asset);
    if (a && a.frames.length > 1) s += `${slot.key}${frameIndexAt(a, sceneTime)};`;
  }
  return s;
}

function tick(ts) {
  requestAnimationFrame(tick);
  const dt = lastTs ? Math.min(ts - lastTs, 120) : 0;
  lastTs = ts;
  if (document.hidden) return;

  sceneTime += dt;

  const delta = dimTarget - dim;
  if (Math.abs(delta) > 0.003) {
    dim += delta * Math.min(1, dt / 90);
    dirty = true;
  } else if (dim !== dimTarget) {
    dim = dimTarget;
    dirty = true;
  }

  const sig = frameSignature();
  if (sig !== lastSig) { lastSig = sig; dirty = true; }
  if (!dirty) return;
  dirty = false;

  drawScene(ctx, {
    state: editor.state,
    time: sceneTime,
    scale: renderScale,
    overlay: overlayImg,
    dim,
    preview: true,
    hovered: interactor?.hovered,
    selected: interactor?.selection || null,
    editingText: textEditor?.active ? textEditor.key : null,
  });
  interactor?.paint();
}

function markDirty() { dirty = true; }

/* ---------- 파일 처리 ---------- */

async function placeFile(file, slotKey) {
  if (!file || !file.type.startsWith('image/')) {
    toast('이미지 파일만 넣을 수 있습니다.', 'warn');
    return;
  }
  ui.setStatus('사진을 읽는 중…');
  try {
    const { asset, warning } = await createAsset(file);
    editor.update((s) => {
      // 사각형이 아니라 실제로 비치는 범위에 맞춘다 — 사각형에 맞추면 보이지 않는
      // 여백까지 덮느라 필요 이상으로 확대된다.
      s.slots[slotKey] = {
        asset: asset.id,
        ...defaultPlacement(slotKey, asset.width, asset.height, visibleRect(slotKey)),
      };
    });
    interactor.select({ type: 'slot', key: slotKey });
    clearOutlineCache();
    if (warning) toast(warning, 'warn');
    ui.setStatus('');
    refresh();
  } catch (err) {
    ui.setStatus('');
    toast(`사진을 읽지 못했습니다. ${err.message || ''}`.trim(), 'bad');
  }
}

function requestUpload(slotKey) {
  uploadTarget = slotKey;
  $('file-input').value = '';
  $('file-input').click();
}

/* ---------- 자동 저장 ---------- */

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.set('state', editor.state);
    store.set('savedAt', Date.now());
  }, 900);
}

async function restore() {
  const saved = await store.get('state');
  if (!saved || !saved.slots) return false;
  const ids = SLOTS.map((s) => saved.slots[s.key]?.asset).filter(Boolean);
  let lost = 0;
  for (const id of ids) {
    const ok = await restoreAsset(id);
    if (!ok) {
      lost++;
      for (const s of SLOTS) if (saved.slots[s.key]?.asset === id) saved.slots[s.key] = null;
    }
  }
  // 사용자가 올린 글꼴은 세션이 끝나면 사라지므로, 없는 글꼴을 가리키면 기본값으로 되돌린다.
  let fontLost = false;
  if (saved.font && saved.font !== BASE_FONT && !document.fonts.check(`700 40px "${saved.font}"`)) {
    saved.font = BASE_FONT;
    fontLost = true;
  }

  editor.load(saved);
  if (lost) toast('일부 사진은 되살리지 못했습니다.', 'warn');
  if (fontLost) toast('올려두셨던 글꼴은 다시 넣어 주세요.', 'warn');
  return true;
}

/* ---------- 조립 ---------- */

const ui = new UI(editor, {
  onSelect: (sel) => interactor.select(sel),
  onRequestUpload: requestUpload,
  onRemoveSlot: (key) => {
    editor.update((s) => { s.slots[key] = null; });
    interactor.select(null);
    clearOutlineCache();
    refresh();
  },
  onFitSlot: (key) => {
    const p = editor.state.slots[key];
    const asset = getAsset(p?.asset);
    if (!asset) return;
    editor.update((s) => {
      // 회전·뒤집기는 유지한다 — 크기와 자리만 다시 잡는 버튼이다.
      const { angle, flip } = s.slots[key];
      Object.assign(s.slots[key], defaultPlacement(key, asset.width, asset.height, visibleRect(key)), { angle, flip });
    });
    refresh();
  },
  onCenterSlot: (key) => {
    const r = visibleRect(key);
    editor.update((s) => {
      const p = s.slots[key];
      if (!p) return;
      p.x = r.x + r.w / 2;
      p.y = r.y + r.h / 2;
    });
    refresh();
  },
  onEditText: (key) => textEditor.start(key),
  onSearch: (term) => {
    const t = term.trim();
    if (!t) { toast('찾을 게임 이름을 적어 주세요.'); return; }
    window.open(LINKS.sgdb(t), '_blank', 'noopener');
  },
  onDirty: markDirty,
});

const interactor = new Interactor($('handles'), editor, {
  onSelect: (sel) => {
    ui.setSelection(sel);
    dimTarget = sel?.type === 'slot' && sel.key !== 'logo' && editor.state.slots[sel.key] ? 1 : 0;
    if (textEditor.active && (!sel || sel.type !== 'text' || sel.key !== textEditor.key)) textEditor.finish();
  },
  onRequestUpload: requestUpload,
  onEditText: (key) => textEditor.start(key),
  onChange: () => { markDirty(); queueSync(); },
});

const textEditor = new TextEditor(
  $('stage-wrap'),
  editor,
  () => stage.getBoundingClientRect().width / CANVAS.w,
  {
    onChange: () => { markDirty(); queueSync(); },
    onDone: () => markDirty(),
    measureCtx: () => measure,
  },
);

const exportDialog = new ExportDialog(editor, {
  onMeasure: async (format, opts, cb) => {
    if (format === 'png') return measurePng(editor.state, overlayImg, opts);
    return estimateGifSizes(editor.state, overlayImg, { ...opts, ...cb });
  },
  onRun: async (format, opts, cb) => {
    const wasEditing = textEditor.active;
    if (wasEditing) textEditor.finish();
    const saved = interactor.selection;
    interactor.selection = null;
    markDirty();
    try {
      if (format === 'png') return await exportPng(editor.state, overlayImg, opts);
      if (format === 'gif') return await exportGif(editor.state, overlayImg, { ...opts, ...cb });
      return await exportVideo(editor.state, overlayImg, { ...opts, ...cb });
    } finally {
      interactor.selection = saved;
      markDirty();
    }
  },
});

function refresh() {
  ui.sync();
  ui.setHistory(editor.historyInfo());
  markDirty();
}

// 상태가 바뀌면 인스펙터도 따라와야 한다 — 특히 문구 넘침 경고는 슬라이더를
// 끄는 동안 실시간으로 갱신돼야 의미가 있다. 드래그 중엔 매 프레임 호출되므로
// 프레임당 한 번으로 묶어 DOM 쓰기를 제한한다.
let syncQueued = false;
function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => { syncQueued = false; ui.sync(); });
}

editor.addEventListener('change', () => { markDirty(); queueSync(); scheduleSave(); });
editor.addEventListener('history', (e) => ui.setHistory(e.detail));

/* ---------- 전역 입력 ---------- */

$('file-input').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) placeFile(f, uploadTarget);
});

$('font-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const family = `Custom${++customFontSeq}`;
    const face = new FontFace(family, await file.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    editor.update((s) => { s.font = family; });
    ui.setFontName(file.name.replace(/\.[^.]+$/, ''));
    textEditor.layout();
    refresh();
    toast('글꼴을 바꿨습니다.');
  } catch {
    toast('이 글꼴 파일은 읽지 못했습니다.', 'bad');
  }
});

$('zoom-in').addEventListener('click', () => stepZoom(1));
$('zoom-out').addEventListener('click', () => stepZoom(-1));
$('zoom-level').addEventListener('click', () => setZoom(0));

// Ctrl+휠(트랙패드 핀치 포함)은 브라우저 확대가 아니라 캔버스 배율로 쓴다.
// 캔버스 편집기에서 익숙한 동작이고, 사진 크기 조절(그냥 휠)과도 겹치지 않는다.
// 브라우저 확대가 필요하면 Ctrl +/- 키는 그대로 살아 있다.
stageArea.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom((viewZoom || fitZoom) * Math.pow(1.0016, -e.deltaY), anchorFrom(e));
}, { passive: false });

$('btn-undo').addEventListener('click', () => { editor.undo(); afterHistory(); });
$('btn-redo').addEventListener('click', () => { editor.redo(); afterHistory(); });

$('btn-export').addEventListener('click', () => exportDialog.open());

$('btn-reset').addEventListener('click', async () => {
  if (!confirm('지금까지 만든 걸 모두 지우고 처음부터 시작할까요?')) return;
  textEditor.finish();
  interactor.select(null);
  editor.reset();
  disposeUnused([]);
  await store.clear();
  clearOutlineCache();
  ui.setFontName('평택 노을체');
  refresh();
});

function afterHistory() {
  textEditor.finish();
  clearOutlineCache();
  const sel = interactor.selection;
  if (sel?.type === 'slot' && !editor.state.slots[sel.key]) interactor.select(null);
  refresh();
}

window.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, textarea, select');
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? editor.redo() : editor.undo();
    afterHistory();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    editor.redo();
    afterHistory();
    return;
  }
  if (typing) return;

  const sel = interactor.selection;

  if (e.key === 'Escape') { interactor.select(null); return; }

  if (sel && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    if (sel.type === 'slot' && editor.state.slots[sel.key]) {
      editor.update((s) => { s.slots[sel.key] = null; });
      interactor.select(null);
      clearOutlineCache();
      refresh();
    }
    return;
  }

  if (sel && e.key === 'Enter' && sel.type === 'text') {
    e.preventDefault();
    textEditor.start(sel.key);
    return;
  }

  const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (sel && nudge) {
    e.preventDefault();
    const k = e.shiftKey ? 10 : 1;
    editor.update((s) => {
      if (sel.type === 'slot') {
        const p = s.slots[sel.key];
        if (!p) return;
        p.x += nudge[0] * k;
        p.y += nudge[1] * k;
      } else {
        const t = s.texts[sel.key];
        t.dx = (t.dx || 0) + nudge[0] * k;
        t.dy = (t.dy || 0) + nudge[1] * k;
      }
    }, { coalesce: `nudge:${sel.key}` });
    refresh();
  }
});

// 붙여넣기 — 스크린샷을 바로 꽂을 수 있게
window.addEventListener('paste', (e) => {
  if (e.target.matches?.('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  const sel = interactor.selection;
  placeFile(file, sel?.type === 'slot' ? sel.key : uploadTarget);
});

// 끌어놓기 — 캔버스 위 좌표로 어느 칸인지 알아낸다
let dragDepth = 0;
const veil = $('drop-veil');

window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  veil.hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) veil.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;

  const rect = stage.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * CANVAS.w;
  const y = ((e.clientY - rect.top) / rect.height) * CANVAS.h;
  let target = interactor.selection?.type === 'slot' ? interactor.selection.key : null;
  if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
    target = null;
    for (const key of ['logo', 'phone', 'bubble']) {
      const r = SLOT_MAP[key].rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { target = key; break; }
    }
  }
  placeFile(file, target || 'bubble');
});

window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => { lastTs = 0; markDirty(); });

/* ---------- 시작 ---------- */

(async function boot() {
  overlayImg = await loadOverlay();
  // 그림의 알파에서 칸마다 실제로 뚫린 범위를 재둔다. 실패해도(그림이 없거나
  // 캔버스가 오염되어도) 사각형으로 물러나므로 앱은 그대로 동작한다.
  measureHoles(overlayImg);
  if (!overlayImg) {
    ui.setStatus('tenka.png 을 찾지 못했습니다. index.html 과 같은 폴더에 있어야 합니다.');
    toast('템플릿 그림(tenka.png)이 없어 배경 없이 보입니다.', 'warn');
  }

  // 글꼴이 준비된 뒤에 그려야 글자 크기 계산이 맞는다.
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`700 40px "${BASE_FONT}"`),
        document.fonts.load('600 14px Pretendard'),
      ]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch { /* 글꼴 없이도 진행 */ }

  const restored = await restore();
  ui.setSelection(null);
  resize();
  refresh();
  requestAnimationFrame(tick);

  if (restored) toast('이전에 하던 작업을 이어서 불러왔습니다.');

  // 안 쓰는 사진은 저장소에서 정리
  const used = SLOTS.map((s) => editor.state.slots[s.key]?.asset).filter(Boolean);
  disposeUnused(used);
})();
