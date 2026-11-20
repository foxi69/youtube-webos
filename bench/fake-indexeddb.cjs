/**
 * A stand-in IndexedDB for the tests of the settings copy (src/config-backup.js).
 */
/**
 * A small IndexedDB: one database whose records are kept in `data` across
 * page loads, with its version and object stores on data.version and
 * data.stores. As the real one: a database opened at a higher version gets
 * onupgradeneeded before onsuccess, and a transaction on a store that was
 * never created throws NotFoundError, so the app must create its store.
 * opts.gate: a promise the cursor waits for before its first record;
 * opts.failAfter: the cursor fails after that many records; opts.openFails:
 * the database does not open (onerror).
 */
function fakeIndexedDB(data, log, opts = {}) {
  const later = (fn) => setTimeout(fn, 1);
  if (!data.stores) data.stores = new Set();
  const notFound = (name) => Object.assign(new Error(`No objectStore named ${name}`), { name: 'NotFoundError' });
  const transaction = (name) => {
    if (!data.stores.has(name)) throw notFound(name);
    const tx = { oncomplete: null, onerror: null, onabort: null };
    const done = () => later(() => tx.oncomplete && tx.oncomplete());
    tx.objectStore = (storeName) => {
      if (storeName !== name) throw notFound(storeName);
      return {
        put(value, key) { data.set(key, value); log.push('put ' + key); done(); },
        delete(key) { data.delete(key); done(); },
        openCursor() {
          const keys = Array.from(data.keys()).sort();
          let i = 0;
          const req = { result: null, onsuccess: null, onerror: null };
          const step = () => later(() => {
            if (opts.failAfter !== undefined && i >= opts.failAfter) {
              req.error = new Error('read failed');
              if (req.onerror) req.onerror();
              return;
            }
            const key = keys[i++];
            req.result = key === undefined ? null : { key, value: data.get(key), continue: step };
            if (req.onsuccess) req.onsuccess();
          });
          if (opts.gate) opts.gate.then(step);
          else step();
          return req;
        }
      };
    };
    return tx;
  };
  const db = { transaction, createObjectStore(name) { data.stores.add(name); } };
  return {
    open(name, version = 1) {
      const req = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        if (opts.openFails) {
          req.error = new Error('open failed');
          if (req.onerror) req.onerror();
          return;
        }
        req.result = db;
        if (version > (data.version || 0)) {
          data.version = version;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
}

/** A copy that an earlier run of the app left: the database with its store, and these records. */
function savedCopy(entries) {
  const data = new Map(entries);
  data.version = 1;
  data.stores = new Set(['kv']);
  return data;
}

module.exports = { fakeIndexedDB, savedCopy };
