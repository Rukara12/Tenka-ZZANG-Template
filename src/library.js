// 작업물 보관함.
//
// 자동 저장되는 '지금 작업'(kv 의 state)과는 따로, 이름 붙여 둔 작업물 목록을
// kv 의 docs 에 담는다. 사진 원본은 blobs 저장소를 그대로 공유하므로 목록에는
// 에셋 id 만 들어간다 — 같은 로고를 쓴 작업물 열 개가 사진을 열 벌 갖지 않는다.
//
// 그래서 blobs 를 정리할 때는 반드시 보관함까지 셈에 넣어야 한다. 지금 작업만
// 기준으로 지우면 보관해 둔 작업물의 사진이 통째로 날아간다. assetIdsOf() 가 그 용도다.

import { store } from './store.js';

const KEY = 'docs';
const LIMIT = 40;

const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** @returns {Promise<Array<{id:string,name:string,savedAt:number,state:object}>>} */
export async function listDocs() {
  const docs = await store.get(KEY);
  return Array.isArray(docs) ? docs : [];
}

/**
 * 지금 상태를 이름 붙여 보관한다. 최신이 앞으로 온다.
 * @param {string} [thumb] 목록에 띄울 미리보기(dataURL). 없어도 동작한다.
 */
export async function saveDoc(name, state, thumb) {
  const docs = await listDocs();
  const doc = {
    id: newId(),
    name: (name || '').trim() || stamp(),
    savedAt: Date.now(),
    thumb: thumb || null,
    state: JSON.parse(JSON.stringify(state)),
  };
  docs.unshift(doc);
  await store.set(KEY, docs.slice(0, LIMIT));
  return doc;
}

export async function deleteDoc(id) {
  const docs = await listDocs();
  await store.set(KEY, docs.filter((d) => d.id !== id));
}

export async function renameDoc(id, name) {
  const docs = await listDocs();
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  doc.name = (name || '').trim() || doc.name;
  await store.set(KEY, docs);
}

/** 보관함 전체가 참조하는 에셋 id. blobs 를 정리할 때 이걸 지켜야 한다. */
export function assetIdsOf(docs) {
  const ids = new Set();
  for (const d of docs) {
    for (const p of Object.values(d.state?.slots || {})) {
      if (p?.asset) ids.add(p.asset);
    }
  }
  return [...ids];
}

export { stamp as timeLabel };
