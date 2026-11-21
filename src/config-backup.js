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

/**
 * The database: null on a TV with no IndexedDB at all (there is no copy
 * there, and never was one); a database that is there but does not open
 * (an error, blocked, a throw) rejects, so a read of it is not taken for an
 * empty copy.
 */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let idb;
    try { idb = window.indexedDB || null; } catch { idb = null; }
    if (!idb) { resolve(null); return; }
    let request;
    try { request = idb.open(DB_NAME, 1); }
    catch (e) { reject(e); return; }
    request.onupgradeneeded = () => {
      try { request.result.createObjectStore(STORE); } catch { /* there already */ }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('backup database failed to open'));
    request.onblocked = () => reject(new Error('backup database blocked'));
  });
  // A failed open is not kept: the next read or write tries again, so one
  // passing error does not leave the rest of the run with no copy.
  const opening = dbPromise;
  opening.catch(() => { if (dbPromise === opening) dbPromise = null; });
  return dbPromise;
}

/** Writes each [key, text] pair; a key whose text is null is deleted. False when it could not. */
export function backupWrite(entries) {
  return openDb().catch(() => null).then((db) => {
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

/**
 * Every [key, text] pair whose key starts with `prefix`; [] when there is no
 * copy (no IndexedDB, or an empty one). A read that fails part way rejects, so
 * a part of the copy is never taken for all of it; so does one with no answer
 * within READ_TIMEOUT_MS (a database that never answers would otherwise keep
 * the restore, and every switch of account waiting for it, for the whole run).
 * Generous: a slow TV's read that does answer must not count as failed (on
 * webOS 25 the read takes well under a second).
 */
const READ_TIMEOUT_MS = 10000;
export function backupReadAll(prefix) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('backup read timed out')), READ_TIMEOUT_MS);
    readAll(prefix).then((out) => { clearTimeout(timer); resolve(out); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function readAll(prefix) {
  return openDb().then((db) => {
    if (!db) return [];
    return new Promise((resolve, reject) => {
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
        request.onerror = () => reject(request.error || new Error('backup read failed'));
      } catch (e) { reject(e); }
    });
  });
}
