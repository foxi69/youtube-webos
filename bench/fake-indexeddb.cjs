/**
 * A stand-in IndexedDB for the tests of the settings copy (src/config-backup.js),
 * and config.js's name for an account's settings record.
 */
/**
 * A small IndexedDB: one database whose records are kept in `data` across
 * page loads, with its version and object stores on data.version and
 * data.stores. As the real one: a database opened at a higher version gets
 * onupgradeneeded before onsuccess, and a transaction on a store that was
 * never created throws NotFoundError, so the app must create its store. A
 * transaction is readonly unless opened 'readwrite': a write in it throws
 * ReadOnlyError, and its cursor still reads. A write transaction's records
 * land only once no cursor is reading, so a read never sees part of a write.
 * opts.gate: a promise the cursor waits for before its first record;
 * opts.failAfter: the cursor fails after that many records (opts.cursorFailed
 * counts the failures delivered, for a test to wait for); opts.openFails:
 * the database does not open (onerror): true for every open, a number for
 * that many first opens; opts.abortWrites: a write transaction
 * aborts (onabort) with none of its records changed; opts.txIds: an array
 * each write's [note, transaction number] is pushed to; opts.opened: set
 * to the number of opens asked for so far; opts.blockFirst: the first open
 * is blocked (onblocked), then gets through 20 ms later, and opts.closed
 * counts the closes of that late connection. opts.conns: an array each
 * opened connection is pushed to; conn.drop() closes it as the browser does
 * (onclose, and a transaction on it throws InvalidStateError), conn.lose()
 * only makes its transactions throw. opts.openGate: a promise each open waits
 * for before it answers (never resolved: an open that never settles).
 * The records are those of the app's database, DB_NAME: an open of any other
 * name fails, so a renamed database (whose users would lose their copy) does
 * not pass the restore tests.
 */
const DB_NAME = 'ytaf-settings-backup';
function fakeIndexedDB(data, log, opts = {}) {
  const later = (fn) => setTimeout(fn, 1);
  if (!data.stores) data.stores = new Set();
  const notFound = (name) => Object.assign(new Error(`No objectStore named ${name}`), { name: 'NotFoundError' });
  let txCount = 0;
  // As the real one: a readwrite transaction on the store waits for the read
  // transactions in progress on it, so a cursor never sees a write land part
  // way. A read is in progress from openCursor until its cursor ends, fails,
  // or a record is delivered without continue() being called.
  let activeReads = 0;
  const waitingCommits = [];
  const whenNoReads = (fn) => { if (activeReads) waitingCommits.push(fn); else fn(); };
  const readDone = () => {
    if (--activeReads === 0) for (const fn of waitingCommits.splice(0)) later(fn);
  };
  const transaction = (name, mode = 'readonly') => {
    if (!data.stores.has(name)) throw notFound(name);
    const writable = () => {
      if (mode !== 'readwrite') throw Object.assign(new Error('The transaction is read-only.'), { name: 'ReadOnlyError' });
    };
    const tx = { oncomplete: null, onerror: null, onabort: null };
    const txId = ++txCount;
    // As the real one: a transaction's writes land together, once, or not at all.
    const staged = [];
    const stage = (apply, note) => {
      staged.push({ apply, note });
      if (staged.length > 1) return;
      later(() => whenNoReads(() => {
        const aborted = !!opts.abortWrites;
        // Logged once done: a test that waits for the log finds the data there.
        for (const write of staged) {
          if (!aborted) write.apply();
          if (write.note) log.push(aborted ? 'aborted ' + write.note : write.note);
          if (write.note && opts.txIds) opts.txIds.push([write.note, txId]);
        }
        const finished = aborted ? tx.onabort : tx.oncomplete;
        if (finished) finished();
      }));
    };
    tx.objectStore = (storeName) => {
      if (storeName !== name) throw notFound(storeName);
      return {
        put(value, key) { writable(); stage(() => data.set(key, value), 'put ' + key); },
        delete(key) { writable(); stage(() => data.delete(key)); },
        openCursor() {
          const keys = Array.from(data.keys()).sort();
          let i = 0;
          const req = { result: null, onsuccess: null, onerror: null };
          activeReads++;
          let continued = false;
          let ended = false;
          const end = () => { ended = true; readDone(); };
          const step = () => {
            // As the real one: once its transaction is done, the cursor cannot go on.
            if (ended) throw Object.assign(new Error('The transaction has finished.'), { name: 'TransactionInactiveError' });
            continued = true;
            later(() => {
            continued = false;
            if (opts.failAfter !== undefined && i >= opts.failAfter) {
              req.error = new Error('read failed');
              if (req.onerror) req.onerror();
              opts.cursorFailed = (opts.cursorFailed || 0) + 1;
              end();
              return;
            }
            const key = keys[i++];
            req.result = key === undefined ? null : { key, value: data.get(key), continue: step };
            if (req.onsuccess) req.onsuccess();
            if (key === undefined || !continued) end();
            });
          };
          if (opts.gate) opts.gate.then(step);
          else step();
          return req;
        }
      };
    };
    return tx;
  };
  const db = { transaction, createObjectStore(name) { data.stores.add(name); } };
  let opens = 0;
  return {
    open(name, version = 1) {
      const req = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      const fails = name !== DB_NAME || opts.openFails === true || (typeof opts.openFails === 'number' && opens < opts.openFails);
      // Another name fails before anything else: a blocked first open too.
      const blocked = !!opts.blockFirst && opens === 0 && name === DB_NAME;
      opens++;
      opts.opened = opens;
      const answer = () => later(() => {
        if (blocked) {
          if (req.onblocked) req.onblocked();
          setTimeout(() => {
            req.result = Object.assign({}, db, { close() { opts.closed = (opts.closed || 0) + 1; } });
            if (req.onsuccess) req.onsuccess();
          }, 20);
          return;
        }
        if (fails) {
          req.error = new Error(name !== DB_NAME ? 'not the database these records belong to: ' + name : 'open failed');
          if (req.onerror) req.onerror();
          return;
        }
        const conn = Object.assign({}, db, { closed: false, onclose: null, onversionchange: null });
        conn.transaction = (storeName, mode) => {
          if (conn.closed) throw Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' });
          return transaction(storeName, mode);
        };
        conn.close = () => { conn.closed = true; };
        conn.lose = () => { conn.closed = true; };
        conn.drop = () => { conn.closed = true; if (conn.onclose) conn.onclose(); };
        if (opts.conns) opts.conns.push(conn);
        req.result = conn;
        if (version > (data.version || 0)) {
          data.version = version;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        if (req.onsuccess) req.onsuccess();
      });
      if (opts.openGate) opts.openGate.then(answer);
      else answer();
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
