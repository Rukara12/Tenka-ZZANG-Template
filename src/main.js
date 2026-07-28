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
import {
  exportPng, exportGif, exportVideo, estimateGifSizes, measurePng, copyPng, renderThumb,
} from './exporter.js';
import { listDocs, saveDoc, deleteDoc, assetIdsOf, timeLabel } from './library.js';

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

/* ---------- 올린 글꼴 ---------- */

// 예전에는 세션마다 Custom1, Custom2… 로 이름을 새로 지어 등록만 하고 어디에도
// 두지 않아서, 새로고침하면 사라지고 "다시 넣어 주세요" 라고 알릴 수밖에 없었다.
// 이름을 고정하고 파일을 저장해 두면 다음에 열어도 그대로 쓰인다.
//
// 저장은 blobs 가 아니라 kv 에 한다. blobs 는 keepOnly() 로 정리되는데 글꼴은
// '어느 작업물도 사진으로 참조하지 않는 키'라 정리 때 지워진다.
const USER_FONT = 'TenkaUserFont';
let userFontFace = null;
let userFontName = '';

async function useFontFile(buffer, label, persist) {
  const face = new FontFace(USER_FONT, buffer.slice(0));
  await face.load();
  if (userFontFace) document.fonts.delete(userFontFace);
  document.fonts.add(face);
  userFontFace = face;
  userFontName = label || '내 글꼴';
  if (persist) await store.set('userFont', { name: userFontName, buffer });
}

/** 저장해 둔 글꼴을 다시 등록한다. 상태를 복원하기 전에 불러야 한다. */
async function restoreUserFont() {
  const rec = await store.get('userFont');
  if (!rec?.buffer) return;
  try {
    await useFontFile(rec.buffer, rec.name, false);
  } catch {
    await store.del('userFont'); // 못 읽는 파일이면 미련 없이 버린다
  }
}

function syncFontUi() {
  const isUser = editor.state.font === USER_FONT;
  ui.setFontName(isUser ? userFontName : '평택 노을체');
  const btn = $('font-toggle');
  btn.hidden = !userFontFace;
  btn.textContent = isUser ? '기본 글꼴로' : `${userFontName} 로`;
}

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

/* ---------- UI 크기 ---------- */

// 기본 13px 글씨는 큰 모니터에서 지나치게 작다. 그렇다고 모두에게 175% 를 물리면
// 노트북에서는 과하므로, 화면 실물 크기로 기본값을 잡고 직접 바꿀 수 있게 한다.
// (창 크기가 아니라 screen 을 보는 이유: 창을 줄여 쓴다고 글씨가 작아야 할 이유는 없다)
function autoUiScale() {
  const w = globalThis.screen?.width || 1280;
  if (w >= 3000) return 1.75;
  if (w >= 2400) return 1.5;
  if (w >= 1800) return 1.25;
  return 1;
}

let uiScale = 1;

function applyUiScale(v, persist) {
  uiScale = Math.min(2, Math.max(1, Number(v) || 1));
  document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  $('ui-scale').value = String(uiScale);
  if (persist) store.set('uiScale', uiScale);
  // 화면 배율이 바뀌면 캔버스가 차지할 공간도 바뀐다.
  resize();
}

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
  // UI 크기(zoom)만큼 실제 화면 픽셀도 늘어나므로 같이 곱해야 흐릿해지지 않는다.
  const dpr = Math.min((globalThis.devicePixelRatio || 1) * uiScale, 2.5);
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

// 자동 저장은 되는데 화면에 아무 표시가 없으면 "닫아도 되나?" 하는 불안이 남는다.
// 더 중요한 건 실패했을 때다 — 저장소가 막혀 있으면(사생활 보호 모드, 용량 초과)
// store 가 조용히 포기하므로, 알려주지 않으면 다 날린 뒤에야 알게 된다.
let saveTimer = null;
let savedAt = 0;
let saveState = 'idle'; // idle | saving | saved | failed

function renderSaveState() {
  const el = $('save-state');
  if (!el) return;
  el.classList.toggle('bad', saveState === 'failed');
  if (saveState === 'failed') { el.textContent = '저장 안 됨 — 브라우저 저장소를 쓸 수 없습니다'; return; }
  if (saveState === 'saving') { el.textContent = '저장 중…'; return; }
  if (!savedAt) { el.textContent = ''; return; }
  const min = Math.floor((Date.now() - savedAt) / 60000);
  el.textContent = min < 1 ? '방금 저장됨' : min < 60 ? `${min}분 전 저장됨` : '저장됨';
}

function scheduleSave() {
  clearTimeout(saveTimer);
  if (saveState !== 'failed') { saveState = 'saving'; renderSaveState(); }
  saveTimer = setTimeout(async () => {
    const ok = await store.set('state', editor.state);
    await store.set('savedAt', Date.now());
    savedAt = Date.now();
    saveState = ok ? 'saved' : 'failed';
    renderSaveState();
  }, 900);
}

setInterval(renderSaveState, 30000);

/** 상태가 가리키는 사진들을 저장소에서 되살린다. @returns 되살리지 못한 개수 */
async function hydrate(saved) {
  const ids = SLOTS.map((s) => saved.slots?.[s.key]?.asset).filter(Boolean);
  let lost = 0;
  for (const id of ids) {
    if (await restoreAsset(id)) continue;
    lost++;
    for (const s of SLOTS) if (saved.slots[s.key]?.asset === id) saved.slots[s.key] = null;
  }
  return lost;
}

/**
 * 안 쓰는 사진을 저장소에서 정리한다.
 * 보관함이 참조하는 것까지 세어야 보관해 둔 작업물의 사진이 살아남는다.
 */
async function pruneAssets() {
  const used = SLOTS.map((s) => editor.state.slots[s.key]?.asset).filter(Boolean);
  const keep = new Set(used);
  for (const id of assetIdsOf(await listDocs())) keep.add(id);
  disposeUnused(used, [...keep]);
}

async function restore() {
  const saved = await store.get('state');
  if (!saved || !saved.slots) return false;
  const lost = await hydrate(saved);
  // 사용자가 올린 글꼴은 세션이 끝나면 사라지므로, 없는 글꼴을 가리키면 기본값으로 되돌린다.
  let fontLost = false;
  if (saved.font && saved.font !== BASE_FONT && !document.fonts.check(`700 40px "${saved.font}"`)) {
    saved.font = BASE_FONT;
    fontLost = true;
  }

  editor.load(saved);
  if (lost) toast('일부 사진은 되살리지 못했습니다.', 'warn');
  // 글꼴은 이제 저장되므로 보통은 여기 걸리지 않는다. 예전 방식(Custom1 같은
  // 세션용 이름)으로 저장된 작업물을 여는 경우에만 해당한다.
  if (fontLost) toast('예전에 쓰던 글꼴을 찾지 못해 기본 글꼴로 열었습니다.', 'warn');
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
    // 사진을 만지는 동안에는 템플릿 그림과 문구를 물려 둔다. 예전에는 로고만
    // 빼놨는데, 그래서 로고를 고를 때만 화면이 그대로여서 다른 칸과 느낌이 달랐다.
    // 로고는 그림 위에 얹히므로 그림을 물려도 로고 자체는 또렷하게 남는다.
    dimTarget = sel?.type === 'slot' && editor.state.slots[sel.key] ? 1 : 0;
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
  onCopy: async (opts) => {
    const wasEditing = textEditor.active;
    if (wasEditing) textEditor.finish();
    const saved = interactor.selection;
    interactor.selection = null;
    markDirty();
    try {
      return await copyPng(editor.state, overlayImg, opts);
    } finally {
      interactor.selection = saved;
      markDirty();
    }
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
  syncFontUi();
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
    await useFontFile(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''), true);
    editor.update((s) => { s.font = USER_FONT; });
    textEditor.layout();
    refresh();
    toast('글꼴을 바꿨습니다. 다음에 열어도 그대로 쓰입니다.');
  } catch {
    toast('이 글꼴 파일은 읽지 못했습니다.', 'bad');
  }
});

$('font-toggle').addEventListener('click', () => {
  editor.update((s) => { s.font = s.font === USER_FONT ? BASE_FONT : USER_FONT; });
  textEditor.layout();
  refresh();
});

/* ---------- 보관함 ---------- */

const libDialog = $('library-dialog');
const helpDialog = $('help-dialog');

function libRow(doc) {
  const row = document.createElement('div');
  row.className = 'lib-item';
  const filled = Object.values(doc.state?.slots || {}).filter(Boolean).length;
  row.innerHTML = `<span class="lib-thumb"></span>
    <span class="lib-item-body">
      <span class="lib-item-name"></span>
      <span class="lib-item-sub"></span>
    </span>
    <button type="button" class="ghost-btn" data-act="load">불러오기</button>
    <button type="button" class="ghost-btn danger" data-act="del">삭제</button>`;

  // 예전에 저장한 작업물에는 미리보기가 없다 — 자리만 비워 두고 그대로 쓴다.
  const thumb = row.querySelector('.lib-thumb');
  if (doc.thumb) {
    const img = document.createElement('img');
    img.src = doc.thumb;
    img.alt = '';
    thumb.appendChild(img);
  } else {
    thumb.classList.add('is-empty');
  }

  row.querySelector('.lib-item-name').textContent = doc.name;
  row.querySelector('.lib-item-sub').textContent =
    `${timeLabel(new Date(doc.savedAt))} · 사진 ${filled}장`;

  row.querySelector('[data-act="load"]').addEventListener('click', async () => {
    if (!confirm(`"${doc.name}" 을 불러올까요?\n지금 작업은 저장하지 않으면 사라집니다.`)) return;
    const state = JSON.parse(JSON.stringify(doc.state));
    const lost = await hydrate(state);
    textEditor.finish();
    interactor.select(null);
    editor.load(state);
    clearOutlineCache();
    await pruneAssets();
    refresh();
    libDialog.close();
    toast(lost ? '일부 사진은 되살리지 못했습니다.' : `"${doc.name}" 을 불러왔습니다.`, lost ? 'warn' : '');
  });

  row.querySelector('[data-act="del"]').addEventListener('click', async () => {
    if (!confirm(`"${doc.name}" 을 보관함에서 지울까요?`)) return;
    await deleteDoc(doc.id);
    await pruneAssets();
    renderLibrary();
  });
  return row;
}

async function renderLibrary() {
  const list = $('lib-list');
  const docs = await listDocs();
  list.textContent = '';
  if (!docs.length) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty';
    empty.textContent = '보관해 둔 작업물이 없습니다. 지금 작업을 저장해 두면 나중에 이어서 쓰거나 사본을 만들 수 있습니다.';
    list.appendChild(empty);
    return;
  }
  for (const doc of docs) list.appendChild(libRow(doc));
}

$('btn-library').addEventListener('click', async () => {
  $('lib-name').value = '';
  await renderLibrary();
  libDialog.showModal();
});
$('lib-close').addEventListener('click', () => libDialog.close());
$('lib-save').addEventListener('click', async () => {
  const btn = $('lib-save');
  btn.disabled = true;
  try {
    // 미리보기를 못 만들어도 보관 자체는 되어야 한다.
    const thumb = await renderThumb(editor.state, overlayImg).catch(() => null);
    const doc = await saveDoc($('lib-name').value, editor.state, thumb);
    $('lib-name').value = '';
    await renderLibrary();
    toast(`"${doc.name}" 으로 보관했습니다.`);
  } finally {
    btn.disabled = false;
  }
});

$('ui-scale').addEventListener('change', (e) => applyUiScale(e.target.value, true));

$('btn-help').addEventListener('click', () => helpDialog.showModal());
$('help-close').addEventListener('click', () => helpDialog.close());

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
  if (!confirm('지금 작업을 지우고 처음부터 시작할까요?\n보관함에 저장해 둔 작업물은 남습니다.')) return;
  textEditor.finish();
  interactor.select(null);
  editor.reset();
  // store.clear() 는 보관함과 그 사진까지 통째로 날린다. 지금 작업만 지운다.
  await store.del('state');
  await store.del('savedAt');
  await pruneAssets();
  savedAt = 0;
  if (saveState !== 'failed') saveState = 'idle';
  renderSaveState();
  clearOutlineCache();
  refresh(); // 글꼴 표시는 syncFontUi 가 상태를 보고 맞춘다
});

function afterHistory() {
  textEditor.finish();
  clearOutlineCache();
  const sel = interactor.selection;
  if (sel?.type === 'slot' && !editor.state.slots[sel.key]) interactor.select(null);
  refresh();
}

window.addEventListener('keydown', (e) => {
  // 대화상자가 열려 있으면 캔버스 단축키는 쉰다. 보관함을 보는 중에 Ctrl+Z 가
  // 뒤에서 작업을 되돌리고 있으면 곤란하다. (Esc 로 닫는 건 브라우저가 처리한다)
  if (document.querySelector('dialog[open]')) return;

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

  // 화면 크기를 먼저 정한다. 나중에 하면 캔버스를 두 번 계산하게 된다.
  applyUiScale((await store.get('uiScale')) ?? autoUiScale(), false);

  // 저장해 둔 글꼴을 먼저 등록한다. 이걸 restore() 뒤로 미루면 상태가 가리키는
  // 글꼴이 아직 없는 것으로 판정돼 기본 글꼴로 되돌려 버린다.
  await restoreUserFont();

  const restored = await restore();
  if (restored) {
    savedAt = (await store.get('savedAt')) || Date.now();
    saveState = 'saved';
    renderSaveState();
  }
  ui.setSelection(null);
  resize();
  refresh();
  requestAnimationFrame(tick);

  if (restored) toast('이전에 하던 작업을 이어서 불러왔습니다.');

  await pruneAssets();
})();
