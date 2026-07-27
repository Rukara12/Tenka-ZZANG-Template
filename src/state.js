// 단일 상태 모델과 히스토리.
// 핵심: 이미지 바이너리는 절대 상태에 넣지 않는다. 에셋 ID만 담으므로
// 스냅샷 하나가 1KB 안팎이고, 따라서 깊은 되돌리기가 공짜에 가깝다.

import { defaultState, migrateState } from './config.js';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 700;

export class Editor extends EventTarget {
  constructor() {
    super();
    this.state = defaultState();
    this.history = [JSON.stringify(this.state)];
    this.step = 0;
    this._coalesceKey = null;
    this._coalesceAt = 0;
    this._pending = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * 상태를 바꾸고 히스토리에 기록한다.
   * @param {(s:object)=>void} fn 변경 함수
   * @param {object} [opts]
   * @param {string} [opts.coalesce] 같은 키로 연속 호출되면 한 항목으로 합친다(타이핑·슬라이더).
   * @param {boolean} [opts.silent] 히스토리에 남기지 않는다.
   */
  update(fn, opts = {}) {
    fn(this.state);
    this.emit('change', { state: this.state });
    if (opts.silent) return;
    this.commit(opts.coalesce);
  }

  commit(coalesce) {
    const snap = JSON.stringify(this.state);
    if (snap === this.history[this.step]) return;

    const now = Date.now();
    const merge =
      coalesce != null &&
      coalesce === this._coalesceKey &&
      now - this._coalesceAt < COALESCE_MS &&
      this.step > 0;

    if (merge) {
      this.history[this.step] = snap;
    } else {
      this.history.length = this.step + 1;
      this.history.push(snap);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      this.step = this.history.length - 1;
    }
    this._coalesceKey = coalesce ?? null;
    this._coalesceAt = now;
    this.emit('history', this.historyInfo());
  }

  /** 병합 창을 즉시 닫는다. (포커스 아웃, 포인터 업 등) */
  seal() {
    this._coalesceKey = null;
  }

  historyInfo() {
    return { canUndo: this.step > 0, canRedo: this.step < this.history.length - 1 };
  }

  undo() {
    if (this.step <= 0) return false;
    this.step--;
    this._restore();
    return true;
  }

  redo() {
    if (this.step >= this.history.length - 1) return false;
    this.step++;
    this._restore();
    return true;
  }

  _restore() {
    this.state = JSON.parse(this.history[this.step]);
    this.seal();
    this.emit('change', { state: this.state, restored: true });
    this.emit('history', this.historyInfo());
  }

  /**
   * 저장된 상태로 통째 교체 (자동 복구용).
   * 얕은 병합이 아니라 migrateState 를 거친다 — config.js 의 SLOTS·TEXTS 가
   * 늘어나도 기존 저장본이 앱을 깨뜨리지 않게 하려는 것.
   */
  load(state) {
    this.state = migrateState(state);
    this.history = [JSON.stringify(this.state)];
    this.step = 0;
    this.seal();
    this.emit('change', { state: this.state, restored: true });
    this.emit('history', this.historyInfo());
  }

  reset() {
    this.update(() => {
      this.state = defaultState();
    });
  }
}
