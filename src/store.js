// 자동 저장소. GIF 원본은 수 MB라 localStorage로는 안 되므로 IndexedDB를 쓴다.
// 실패해도 앱은 그대로 동작해야 하므로 모든 경로에서 조용히 포기한다.

const DB_NAME = 'tenka-editor';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB 없음'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const store = {
  async get(key) {
    try { return await tx('kv', 'readonly', (s) => s.get(key)); }
    catch { return undefined; }
  },
  async set(key, value) {
    try { await tx('kv', 'readwrite', (s) => s.put(value, key)); return true; }
    catch { return false; }
  },
  async del(key) {
    try { await tx('kv', 'readwrite', (s) => s.delete(key)); } catch { /* 무시 */ }
  },
  async getBlob(id) {
    try { return await tx('blobs', 'readonly', (s) => s.get(id)); }
    catch { return undefined; }
  },
  async putBlob(id, blob) {
    try { await tx('blobs', 'readwrite', (s) => s.put(blob, id)); return true; }
    catch { return false; }
  },
  async keepOnly(ids) {
    try {
      const db = await openDb();
      const keys = await new Promise((res, rej) => {
        const t = db.transaction('blobs', 'readonly');
        const rq = t.objectStore('blobs').getAllKeys();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      const dead = keys.filter((k) => !ids.includes(k));
      if (!dead.length) return;
      await tx('blobs', 'readwrite', (s) => { for (const k of dead) s.delete(k); });
    } catch { /* 무시 */ }
  },
  async clear() {
    try {
      await tx('kv', 'readwrite', (s) => s.clear());
      await tx('blobs', 'readwrite', (s) => s.clear());
    } catch { /* 무시 */ }
  },
};
