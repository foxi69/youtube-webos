/**
 * The copy of the settings in IndexedDB (src/config-backup.js): settings in
 * localStorage are copied there, a change is copied too, and an app started
 * with localStorage emptied (as YouTube TV does now and then) gets them back,
 * per-account profiles included. Without IndexedDB nothing breaks.
 *
 * Usage: node bench/settings-backup-test.cjs [dist/webOSUserScripts/userScript.js] [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, wait, until, UA } = require('./harness.cjs');

const KEY = 'ytaf-configuration';

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

function boot({ config, storage, data, log, noIdb, idb = {}, setup }) {
  const page = bootPage({
    bodyClass: 'WEB_PAGE_TYPE_BROWSE',
    userAgent: UA.webos23,
    launchParams: '{}',
    raf: 'timer',
    config,
    storage,
    consoleErrors: false,
    restoreRemove: false,
    setup: (w) => {
      w.indexedDB = noIdb ? undefined : fakeIndexedDB(data, log, idb);
      if (setup) setup(w);
    },
    fetch: () => Promise.reject(new Error('offline'))
  });
  return page;
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
const PROFILE_KEY = KEY + '::' + hashString('accountId=abc');
const IDENTITY = { 'yt.leanback.default::last-identity-used': JSON.stringify({ data: { accountId: 'abc' } }) };

// The value a choice row of the panel shows.
async function panelValue(win, label) {
  if (!win.document.querySelector('.ytaf-ui-container')) {
    trustedKey(win, 404, win.document.body, 'keydown');
    trustedKey(win, 404, win.document.body, 'keyup');
    await wait(300);
  }
  const row = Array.prototype.slice.call(win.document.querySelectorAll('.shortcut-control-row'))
    .find((r) => r.querySelector('.shortcut-label').textContent.trim() === label);
  return row ? row.querySelector('.current-value').textContent : 'no row';
}

const stored = (win, key = KEY) => JSON.parse(win.localStorage.getItem(key) || 'null');

const { t, run } = createReporter();

run(async () => {
  const data = new Map();
  const log = [];

  // ---- The settings stored are copied a little after the start ----
  const first = boot({ config: { minVideoLength: '5', blockedChannels: ['Some Channel'], foxThemeApplied: true }, data, log });
  await wait(1800);
  const copy = data.has(KEY) ? JSON.parse(data.get(KEY)) : null;
  t('the stored settings are copied', !!copy && copy.minVideoLength === '5' && copy.blockedChannels[0] === 'Some Channel',
    JSON.stringify(copy));

  // ---- A change is copied ----
  trustedKey(first.win, 404, first.win.document.body, 'keydown');
  trustedKey(first.win, 404, first.win.document.body, 'keyup');
  await wait(300);
  const box = Array.prototype.slice.call(first.win.document.querySelectorAll('label'))
    .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
  if (box) box.querySelector('input').click();
  await wait(400);
  const changed = data.has(KEY) ? JSON.parse(data.get(KEY)) : null;
  t('a change in the panel is copied', !!box && !!changed && changed.removeUpscaledFormats === false,
    JSON.stringify(changed && changed.removeUpscaledFormats));

  // ---- localStorage emptied: the next start gets them back ----
  const second = boot({ data, log });
  await wait(300);
  const back = stored(second.win);
  t('an app started with no settings writes the copy back',
    !!back && back.minVideoLength === '5' && back.blockedChannels[0] === 'Some Channel' && back.removeUpscaledFormats === false, JSON.stringify(back));
  trustedKey(second.win, 404, second.win.document.body, 'keydown');
  trustedKey(second.win, 404, second.win.document.body, 'keyup');
  await wait(300);
  const lengthRow = Array.prototype.slice.call(second.win.document.querySelectorAll('.shortcut-control-row'))
    .find((r) => r.querySelector('.shortcut-label').textContent.trim() === 'Hide Videos Shorter Than');
  t('...and the restored values are in use at once', !!lengthRow && lengthRow.querySelector('.current-value').textContent === '5 min',
    lengthRow ? lengthRow.querySelector('.current-value').textContent : 'no row');
  t('...and nothing threw', second.errors.length === 0, second.errors[0]);

  // ---- Per-account profiles go back too ----
  const profiles = savedCopy([
    [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
    [KEY + '::0123456789abcdef', JSON.stringify({ minVideoLength: '20' })]
  ]);
  const third = boot({ data: profiles, log: [] });
  await wait(300);
  t('a profile is written back with the shared settings',
    !!stored(third.win) && stored(third.win).perAccountSettings === true &&
    !!stored(third.win, KEY + '::0123456789abcdef') && stored(third.win, KEY + '::0123456789abcdef').minVideoLength === '20');

  // ---- No copy: the defaults stay, and a write after it is copied ----
  const empty = new Map();
  const fresh = boot({ data: empty, log: [] });
  await wait(600);
  const freshCopy = empty.has(KEY) ? JSON.parse(empty.get(KEY)) : null;
  t('a fresh install has its first write copied once the copy was looked for',
    !!freshCopy && freshCopy.foxThemeApplied === true, JSON.stringify(freshCopy));
  t('...with the defaults', !!stored(fresh.win) && stored(fresh.win).minVideoLength === '0');

  // ---- The copy is not written over before it was read ----
  {
    const backup = savedCopy([[KEY, JSON.stringify({ minVideoLength: '5', foxThemeApplied: true })]]);
    const before = backup.get(KEY);
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = boot({ data: backup, log: [], idb: { gate } });
    // The app writes its settings (foxThemeApplied) 200 ms in, while the read waits.
    await wait(500);
    t('a write before the copy was read leaves the copy as it was', backup.get(KEY) === before &&
      !!stored(page.win) && stored(page.win).minVideoLength === '0', backup.get(KEY));
    release();
    await wait(400);
    t('...and once read, the copy comes back', !!stored(page.win) && stored(page.win).minVideoLength === '5' &&
      JSON.parse(backup.get(KEY)).minVideoLength === '5', JSON.stringify(stored(page.win)));
  }

  // ---- A setting changed in the panel before the copy was read keeps its change ----
  {
    const backup = savedCopy([[KEY, JSON.stringify({ minVideoLength: '5', removeUpscaledFormats: true, foxThemeApplied: true })]]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = boot({ data: backup, log: [], idb: { gate } });
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await wait(300);
    const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
    const input = label && label.querySelector('input');
    t('precondition: the switch is on, from the defaults, while the copy is not read yet',
      !!input && input.checked === true && !!stored(page.win) && stored(page.win).minVideoLength === '0',
      JSON.stringify(stored(page.win)));
    if (input) input.click();
    await wait(300);
    release();
    await wait(400);
    const after = stored(page.win);
    t('a change made before the copy was read stays, in localStorage and in use',
      !!after && after.removeUpscaledFormats === false && !!input && input.checked === false, JSON.stringify(after));
    t('...and the other settings still come back from the copy', !!after && after.minVideoLength === '5', JSON.stringify(after));
    t('...and the copy gets the change too', JSON.parse(backup.get(KEY)).removeUpscaledFormats === false &&
      JSON.parse(backup.get(KEY)).minVideoLength === '5', backup.get(KEY));
  }

  // ---- The same with Separate Settings for Each Account: the account's restored profile keeps the change too ----
  {
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, minVideoLength: '1' })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20', removeUpscaledFormats: true })]
    ]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = boot({ data: backup, log: [], storage: IDENTITY, idb: { gate } });
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await wait(300);
    const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
    const input = label && label.querySelector('input');
    t('precondition (accounts): the switch is on while the copy is not read yet', !!input && input.checked === true);
    if (input) input.click();
    await wait(300);
    release();
    await wait(700);
    const profile = stored(page.win, PROFILE_KEY);
    t('accounts: the change stays in use once the account has loaded its restored profile',
      !!input && input.checked === false && await panelValue(page.win, 'Hide Videos Shorter Than') === '20 min',
      `${input && input.checked} / ${await panelValue(page.win, 'Hide Videos Shorter Than')}`);
    t('...and is in the account\'s record, with its other settings', !!profile && profile.removeUpscaledFormats === false &&
      profile.minVideoLength === '20', JSON.stringify(profile));
    t('...and in its copy', JSON.parse(backup.get(PROFILE_KEY)).removeUpscaledFormats === false, backup.get(PROFILE_KEY));
  }

  // ---- ...and when the account's record survived in localStorage, but localStorage refuses the changed one ----
  {
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, minVideoLength: '1' })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20', removeUpscaledFormats: true })]
    ]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const oldLocal = JSON.stringify({ minVideoLength: '10', removeUpscaledFormats: true });
    let refused = 0;
    const page = boot({
      data: backup, log: [], idb: { gate },
      storage: Object.assign({ [PROFILE_KEY]: oldLocal }, IDENTITY),
      setup: (w) => {
        const set = w.Storage.prototype.setItem;
        w.Storage.prototype.setItem = function (key, value) {
          if (key === PROFILE_KEY) { refused++; throw new Error('QuotaExceededError'); }
          return set.call(this, key, value);
        };
      }
    });
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await wait(300);
    const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
    const input = label && label.querySelector('input');
    t('precondition (refused write): the switch is on while the copy is not read yet', !!input && input.checked === true);
    if (input) input.click();
    await wait(300);
    release();
    await wait(700);
    // setItem is what the restore writes the changed record with.
    t('...precondition: the changed record was refused', refused > 0, String(refused));
    t('refused write: the change stays in use over the old local record, which gives the account its other settings',
      !!input && input.checked === false && await panelValue(page.win, 'Hide Videos Shorter Than') === '10 min',
      `${input && input.checked} / ${await panelValue(page.win, 'Hide Videos Shorter Than')}`);
  }

  // ---- Separate Settings for Each Account switched on while the copy is still being read ----
  {
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, minVideoLength: '1' })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20' })]
    ]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const log = [];
    const page = boot({ data: backup, log, storage: IDENTITY, idb: { gate } });
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Separate Settings for Each Account');
    const input = label && label.querySelector('input');
    t('precondition (per-account during the read): the switch is off, from the defaults', !!input && input.checked === false);
    if (input) input.click();
    // The account's record, written from the defaults before the copy is read.
    const wroteEarly = await until(() => !!stored(page.win, PROFILE_KEY));
    t('...precondition: the account\'s record was written before the read',
      wroteEarly && stored(page.win, PROFILE_KEY).minVideoLength === '0', JSON.stringify(stored(page.win, PROFILE_KEY)));
    release();
    let restored = false;
    for (let i = 0; i < 60 && !restored; i++) {
      restored = await panelValue(page.win, 'Hide Videos Shorter Than') === '20 min';
      if (!restored) await wait(50);
    }
    t('per-account during the read: the account gets its settings from the copy, not the defaults written meanwhile',
      restored && stored(page.win, PROFILE_KEY).minVideoLength === '20', JSON.stringify(stored(page.win, PROFILE_KEY)));
    await until(() => log.some((l) => l === 'put ' + PROFILE_KEY));
    t('...and its copy keeps them', JSON.parse(backup.get(PROFILE_KEY)).minVideoLength === '20', backup.get(PROFILE_KEY));
    t('...with the switch still on', stored(page.win).perAccountSettings === true, JSON.stringify(stored(page.win)));
  }

  // ---- The account in use gets its own restored settings ----
  {
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, minVideoLength: '1' })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20' })]
    ]);
    const page = boot({ data: backup, log: [], storage: IDENTITY });
    await wait(700);
    t('the active account is given its restored profile, not the shared values',
      await panelValue(page.win, 'Hide Videos Shorter Than') === '20 min', await panelValue(page.win, 'Hide Videos Shorter Than'));
    t('...its record stays in localStorage and in the copy', !!stored(page.win, PROFILE_KEY) &&
      stored(page.win, PROFILE_KEY).minVideoLength === '20' && JSON.parse(backup.get(PROFILE_KEY)).minVideoLength === '20',
      backup.get(PROFILE_KEY));
  }

  // ---- localStorage refuses the account's record (quota) ----
  {
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, minVideoLength: '1' })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20' })]
    ]);
    const page = boot({
      data: backup, log: [], storage: IDENTITY,
      setup: (w) => {
        const set = w.Storage.prototype.setItem;
        w.Storage.prototype.setItem = function (key, value) {
          if (key === PROFILE_KEY) throw new Error('QuotaExceededError');
          return set.call(this, key, value);
        };
      }
    });
    await wait(700);
    t('quota: the restored profile still applies, from memory',
      await panelValue(page.win, 'Hide Videos Shorter Than') === '20 min', await panelValue(page.win, 'Hide Videos Shorter Than'));
    t('quota: ...and its copy is not written over', JSON.parse(backup.get(PROFILE_KEY)).minVideoLength === '20', backup.get(PROFILE_KEY));
  }

  // ---- Quota, then a switch to another account whose record did not fit ----
  {
    const OTHER_KEY = KEY + '::' + hashString('accountId=def');
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, minVideoLength: '1' })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20' })],
      [OTHER_KEY, JSON.stringify({ minVideoLength: '10' })]
    ]);
    const page = boot({
      data: backup, log: [], storage: IDENTITY,
      setup: (w) => {
        const set = w.Storage.prototype.setItem;
        // The other account's record is the one that does not fit, until the app writes a smaller one.
        let refused = false;
        w.Storage.prototype.setItem = function (key, value) {
          if (key === OTHER_KEY && !refused) { refused = true; throw new Error('QuotaExceededError'); }
          return set.call(this, key, value);
        };
      }
    });
    await wait(700);
    // "Who's watching" picks the other account.
    page.win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: { accountId: 'def' } }));
    page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
    page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
    await wait(600);
    t('quota, another account later: it gets its restored settings, not the shared ones',
      await panelValue(page.win, 'Hide Videos Shorter Than') === '10 min', await panelValue(page.win, 'Hide Videos Shorter Than'));
    t('quota, another account later: its copy keeps its own values', JSON.parse(backup.get(OTHER_KEY)).minVideoLength === '10',
      backup.get(OTHER_KEY));
  }

  // ---- The shared record refused: an account's change is still written, and kept across a switch away and back ----
  {
    const OTHER_KEY = KEY + '::' + hashString('accountId=def');
    const refuseShared = { on: false, refused: 0 };
    const page = boot({
      data: new Map(), log: [],
      storage: Object.assign({
        [KEY]: JSON.stringify({ perAccountSettings: true, foxThemeApplied: true }),
        [PROFILE_KEY]: JSON.stringify({ removeUpscaledFormats: true }),
        [OTHER_KEY]: JSON.stringify({ removeUpscaledFormats: true })
      }, IDENTITY),
      // The app writes the records by assignment (localStorage[key] = text):
      // a stand-in that refuses the shared record, by assignment or setItem.
      setup: (w) => {
        const real = w.localStorage;
        const refuse = (key) => {
          if (refuseShared.on && key === KEY) { refuseShared.refused++; throw new Error('QuotaExceededError'); }
        };
        const proxy = new Proxy(real, {
          get(target, prop) {
            if (prop === 'setItem') return (key, value) => { refuse(key); target.setItem(key, value); };
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set(target, prop, value) { refuse(prop); target.setItem(prop, String(value)); return true; }
        });
        Object.defineProperty(w, 'localStorage', { configurable: true, get: () => proxy });
      }
    });
    await wait(400);
    const switchTo = async (accountId) => {
      page.win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: { accountId } }));
      page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
      page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
      await wait(300);
    };
    const box = () => {
      const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
        .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
      return label && label.querySelector('input');
    };
    await panelValue(page.win, 'Hide Videos Shorter Than');
    t('precondition (shared refused): the account starts with the switch on', !!box() && box().checked === true);
    refuseShared.on = true;
    if (box()) box().click();
    await wait(400);
    t('...precondition: the shared record was refused', refuseShared.refused > 0, String(refuseShared.refused));
    t('shared refused: the account\'s change is still written to its record',
      !!stored(page.win, PROFILE_KEY) && stored(page.win, PROFILE_KEY).removeUpscaledFormats === false,
      JSON.stringify(stored(page.win, PROFILE_KEY)));
    await switchTo('def');
    t('...precondition: the other account has its own setting (on)', !!box() && box().checked === true);
    await switchTo('abc');
    t('...and switched away and back, the account has its change', !!box() && box().checked === false);
  }

  // ---- An account record still in localStorage is newer than its copy ----
  {
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20' })]
    ]);
    // The shared record is gone; the account's stayed, changed since the copy was made.
    const local = Object.assign({}, IDENTITY, { [PROFILE_KEY]: JSON.stringify({ minVideoLength: '3' }) });
    const page = boot({ data: backup, log: [], storage: local });
    await wait(700);
    t('a record still in localStorage is kept, not replaced by its copy',
      stored(page.win, PROFILE_KEY).minVideoLength === '3' && await panelValue(page.win, 'Hide Videos Shorter Than') === '3 min',
      JSON.stringify(stored(page.win, PROFILE_KEY)));
    t('...and the shared record still comes back from the copy', !!stored(page.win) && stored(page.win).perAccountSettings === true);
  }

  // ---- A read that fails part way ----
  {
    const backup = savedCopy([
      [KEY, JSON.stringify({ minVideoLength: '5', foxThemeApplied: true })],
      [KEY + '::zzzz', JSON.stringify({ minVideoLength: '20' })]
    ]);
    const shared = backup.get(KEY);
    const page = boot({ data: backup, log: [], idb: { failAfter: 1 } });
    await wait(700);
    t('a failed read restores nothing', !!stored(page.win) && stored(page.win).minVideoLength === '0', JSON.stringify(stored(page.win)));
    t('...and copies nothing over the copy', backup.get(KEY) === shared && backup.has(KEY + '::zzzz'), backup.get(KEY));
  }

  // ---- A failed read, then the next start ----
  {
    const backup = savedCopy([[KEY, JSON.stringify({ minVideoLength: '5', foxThemeApplied: true })]]);
    const first = boot({ data: backup, log: [], idb: { failAfter: 0 } });
    await wait(700);
    // What that run left in localStorage: the defaults it wrote, and the mark that the copy was not read.
    const left = {};
    for (let i = 0; i < first.win.localStorage.length; i++) {
      const k = first.win.localStorage.key(i);
      left[k] = first.win.localStorage.getItem(k);
    }
    t('a failed read leaves the mark for the next start', left['ytaf-settings-recovering'] === '1' && !!left[KEY],
      JSON.stringify(Object.keys(left)));
    const second = boot({ data: backup, log: [], storage: left });
    await wait(1800);
    t('the next start reads the copy again and takes its settings', !!stored(second.win) && stored(second.win).minVideoLength === '5',
      JSON.stringify(stored(second.win)));
    t('...the copy is not replaced by the defaults of the failed run', JSON.parse(backup.get(KEY)).minVideoLength === '5', backup.get(KEY));
    t('...and the mark is gone', second.win.localStorage.getItem('ytaf-settings-recovering') === null);
  }

  // ---- A failed read, then a start whose localStorage refuses the restored shared record, then the next ----
  {
    const backup = savedCopy([[KEY, JSON.stringify({ minVideoLength: '5', foxThemeApplied: true })]]);
    const snapshot = (win) => {
      const out = {};
      for (let i = 0; i < win.localStorage.length; i++) {
        const k = win.localStorage.key(i);
        out[k] = win.localStorage.getItem(k);
      }
      return out;
    };
    const first = boot({ data: backup, log: [], idb: { failAfter: 0 } });
    await wait(700);
    const left = snapshot(first.win);
    t('precondition (refused restore): the failed run left its defaults and the mark',
      left['ytaf-settings-recovering'] === '1' && !!left[KEY] && JSON.parse(left[KEY]).minVideoLength === '0', JSON.stringify(left));
    // The shared record refused, by setItem (the restore) and by assignment (a later write).
    const refuseShared = { on: true, refused: 0 };
    const second = boot({
      data: backup, log: [], storage: left,
      setup: (w) => {
        const real = w.localStorage;
        const refuse = (key) => {
          if (refuseShared.on && key === KEY) { refuseShared.refused++; throw new Error('QuotaExceededError'); }
        };
        const proxy = new Proxy(real, {
          get(target, prop) {
            if (prop === 'setItem') return (key, value) => { refuse(key); target.setItem(key, value); };
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set(target, prop, value) { refuse(prop); target.setItem(prop, String(value)); return true; }
        });
        Object.defineProperty(w, 'localStorage', { configurable: true, get: () => proxy });
      }
    });
    await wait(1800);
    t('...precondition: the restored shared record was refused', refuseShared.refused > 0 && JSON.parse(second.win.localStorage.getItem(KEY)).minVideoLength === '0',
      `${refuseShared.refused} ${second.win.localStorage.getItem(KEY)}`);
    t('...precondition: the copy was read, its settings in use from memory',
      await panelValue(second.win, 'Hide Videos Shorter Than') === '5 min', await panelValue(second.win, 'Hide Videos Shorter Than'));
    const left2 = snapshot(second.win);
    t('refused restore: the mark stays', left2['ytaf-settings-recovering'] === '1', JSON.stringify(Object.keys(left2)));
    const third = boot({ data: backup, log: [], storage: left2 });
    await wait(1800);
    t('...the next start does not copy the defaults left in localStorage over the copy',
      JSON.parse(backup.get(KEY)).minVideoLength === '5', backup.get(KEY));
    t('...it reads the copy again and stores its settings, and the mark is gone',
      !!stored(third.win) && stored(third.win).minVideoLength === '5' && third.win.localStorage.getItem('ytaf-settings-recovering') === null,
      `${JSON.stringify(stored(third.win))} ${third.win.localStorage.getItem('ytaf-settings-recovering')}`);
    // In the refusing run, a write that does store the shared record ends the recovery.
    refuseShared.on = false;
    const label = Array.prototype.slice.call(second.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
    const input = label && label.querySelector('input');
    t('...precondition: the switch is there to change', !!input);
    if (input) input.click();
    const cleared = await until(() => second.win.localStorage.getItem('ytaf-settings-recovering') === null);
    t('refused restore: a later write that stores the shared record removes the mark',
      cleared && JSON.parse(second.win.localStorage.getItem(KEY)).minVideoLength === '5', second.win.localStorage.getItem(KEY));
  }

  // ---- A failed read, then a start that changes a setting before the copy is read again ----
  {
    const backup = savedCopy([[KEY, JSON.stringify({ minVideoLength: '5', removeUpscaledFormats: true, foxThemeApplied: true })]]);
    const before = backup.get(KEY);
    const first = boot({ data: backup, log: [], idb: { failAfter: 0 } });
    await wait(700);
    const left = {};
    for (let i = 0; i < first.win.localStorage.length; i++) {
      const k = first.win.localStorage.key(i);
      left[k] = first.win.localStorage.getItem(k);
    }
    t('precondition (recovering): the failed run left its defaults and the mark',
      left['ytaf-settings-recovering'] === '1' && !!left[KEY] && JSON.parse(left[KEY]).minVideoLength === '0',
      JSON.stringify(left));
    let release;
    const gate = new Promise((r) => { release = r; });
    const log = [];
    const page = boot({ data: backup, log, storage: left, idb: { gate } });
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
    const input = label && label.querySelector('input');
    t('precondition (recovering): the switch is on, from the defaults, while the copy is not read yet',
      !!input && input.checked === true, String(input && input.checked));
    if (input) input.click();
    // Written to localStorage: a copy of that write would be made in the same
    // turn (the database is open by now), so it is checked at once.
    const written = await until(() => stored(page.win).removeUpscaledFormats === false);
    t('...precondition: the change was written to localStorage', written, JSON.stringify(stored(page.win)));
    t('recovering: a write before the copy was read again is not copied over it', backup.get(KEY) === before && log.length === 0,
      `${backup.get(KEY)} ${log.join()}`);
    release();
    await until(() => stored(page.win).minVideoLength === '5');
    t('...once read, its settings come back, with the change kept',
      stored(page.win).minVideoLength === '5' && stored(page.win).removeUpscaledFormats === false, JSON.stringify(stored(page.win)));
    await until(() => log.length > 0);
    t('...and the copy gets the change then, with its other settings',
      JSON.parse(backup.get(KEY)).minVideoLength === '5' && JSON.parse(backup.get(KEY)).removeUpscaledFormats === false, backup.get(KEY));
  }

  // ---- The app's own records written before the copy was read take the copy's ----
  {
    // A copy from before the Fox theme: the flag is the copy's (false), not
    // the true the app writes at start, so the next start moves its theme once.
    const backup = savedCopy([[KEY, JSON.stringify({ minVideoLength: '5', uiTheme: 'blue-force-field', foxThemeApplied: false })]]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = boot({ data: backup, log: [], idb: { gate } });
    const wrote = await until(() => !!stored(page.win) && stored(page.win).foxThemeApplied === true);
    t('precondition: the app writes its flag before the copy is read', wrote, JSON.stringify(stored(page.win)));
    release();
    await until(() => stored(page.win).minVideoLength === '5');
    t('the copy\'s flag takes the place of the one the app wrote',
      stored(page.win).minVideoLength === '5' && stored(page.win).uiTheme === 'blue-force-field' && stored(page.win).foxThemeApplied === false,
      JSON.stringify(stored(page.win)));
    const next = boot({ data: backup, log: [], storage: { [KEY]: page.win.localStorage.getItem(KEY) } });
    await until(() => stored(next.win).foxThemeApplied === true);
    t('...so the next start moves the restored theme to Fox once',
      stored(next.win).uiTheme === 'fox' && stored(next.win).foxThemeApplied === true, JSON.stringify(stored(next.win)));
  }

  // ---- A database that does not open, then the next start ----
  {
    const backup = savedCopy([[KEY, JSON.stringify({ minVideoLength: '5', foxThemeApplied: true })]]);
    const first = boot({ data: backup, log: [], idb: { openFails: true } });
    await wait(700);
    const left = {};
    for (let i = 0; i < first.win.localStorage.length; i++) {
      const k = first.win.localStorage.key(i);
      left[k] = first.win.localStorage.getItem(k);
    }
    t('a database that does not open is no empty copy: the mark stays', left['ytaf-settings-recovering'] === '1',
      JSON.stringify(Object.keys(left)));
    const second = boot({ data: backup, log: [], storage: left });
    await wait(1800);
    t('...and the next start, with the database opening, gets the copy back',
      !!stored(second.win) && stored(second.win).minVideoLength === '5' && JSON.parse(backup.get(KEY)).minVideoLength === '5',
      JSON.stringify(stored(second.win)));
  }

  // ---- No IndexedDB ----
  const none = boot({ config: { minVideoLength: '5' }, noIdb: true, data: new Map(), log: [] });
  await wait(1800);
  t('without IndexedDB nothing breaks', none.errors.length === 0 && stored(none.win).minVideoLength === '5', none.errors[0]);
  const noneEmpty = boot({ noIdb: true, data: new Map(), log: [] });
  await wait(300);
  t('...nor with localStorage empty', noneEmpty.errors.length === 0, noneEmpty.errors[0]);
});
