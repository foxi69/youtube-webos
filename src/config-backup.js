/**
 * A copy of the settings in IndexedDB.
 *
 * The settings live in localStorage, which YouTube TV empties now and then
 * (localStorage.clear() on some sign-outs and app resets), and with it every
 * setting went back to its default. Each write of the settings is copied here,
 * under the same keys; when the app starts with no settings in localStorage,
 * config.js reads the copy back. From Zucchiniii's fork.
 *
 * Every call is best effort: no IndexedDB, a blocked or failing database, or a
 * quota error leaves the settings as they would be without the copy.
 */

const DB_NAME = 'ytaf-settings-backup';
const STORE = 'kv';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let idb;
    try { idb = window.indexedDB || null; } catch { idb = null; }
    if (!idb) { resolve(null); return; }
    let request;
    try { request = idb.open(DB_NAME, 1); }
    catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      try { request.result.createObjectStore(STORE); } catch { /* there already */ }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Writes each [key, text] pair; a key whose text is null is deleted. */
export function backupWrite(entries) {
  return openDb().then((db) => {
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const [key, text] of entries) {
          if (text === null) store.delete(key);
          else store.put(text, key);
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch { resolve(false); }
    });
  });
}

/** Every [key, text] pair whose key starts with `prefix`, or [] when there is no copy. */
export function backupReadAll(prefix) {
  return openDb().then((db) => {
    if (!db) return [];
    return new Promise((resolve) => {
      const out = [];
      try {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(out); return; }
          const key = String(cursor.key);
          if (key.indexOf(prefix) === 0 && typeof cursor.value === 'string') out.push([key, cursor.value]);
          cursor.continue();
        };
        request.onerror = () => resolve(out);
      } catch { resolve(out); }
    });
  });
}
