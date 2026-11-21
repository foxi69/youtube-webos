/**
 * A stand-in IndexedDB for the tests of the settings copy (src/config-backup.js),
 * and config.js's name for an account's settings record.
 */
/**
 * A small IndexedDB: one database whose records are kept in `data` across
 * page loads, with its version and object stores on data.version and
 * data.stores. As the real one: a database opened at a higher version gets
 * onupgradeneeded before onsuccess, and a transaction on a store that was
 * never created throws NotFoundError, so the app must create its store.
 * opts.gate: a promise the cursor waits for before its first record;
 * opts.failAfter: the cursor fails after that many records; opts.openFails:
 * the database does not open (onerror); opts.abortWrites: a write transaction
 * aborts (onabort) with none of its records changed.
 */
function fakeIndexedDB(data, log, opts = {}) {
  const later = (fn) => setTimeout(fn, 1);
  if (!data.stores) data.stores = new Set();
  const notFound = (name) => Object.assign(new Error(`No objectStore named ${name}`), { name: 'NotFoundError' });
  const transaction = (name) => {
    if (!data.stores.has(name)) throw notFound(name);
    const tx = { oncomplete: null, onerror: null, onabort: null };
    // As the real one: a transaction's writes land together, once, or not at all.
    const staged = [];
    const stage = (apply, note) => {
      staged.push({ apply, note });
      if (staged.length > 1) return;
      later(() => {
        const aborted = !!opts.abortWrites;
        // Logged once done: a test that waits for the log finds the data there.
        for (const write of staged) {
          if (!aborted) write.apply();
          if (write.note) log.push(aborted ? 'aborted ' + write.note : write.note);
        }
        const finished = aborted ? tx.onabort : tx.oncomplete;
        if (finished) finished();
      });
    };
    tx.objectStore = (storeName) => {
      if (storeName !== name) throw notFound(storeName);
      return {
        put(value, key) { stage(() => data.set(key, value), 'put ' + key); },
        delete(key) { stage(() => data.delete(key)); },
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

// config.js's profile name for an identity record of { accountId: 'abc' }: its hashString of "accountId=abc".
function hashString(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 15);
  }
  return ('0000000' + (h1 >>> 0).toString(16)).slice(-8) + ('0000000' + (h2 >>> 0).toString(16)).slice(-8);
}

module.exports = { fakeIndexedDB, savedCopy, hashString };
