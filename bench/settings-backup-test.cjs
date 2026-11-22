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

const { fakeIndexedDB, savedCopy, hashString } = require('./fake-indexeddb.cjs');

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
  await until(() => data.has(KEY), 5000);
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
  await until(() => empty.has(KEY), 5000);
  const freshCopy = empty.has(KEY) ? JSON.parse(empty.get(KEY)) : null;
  t('a fresh install has its first write copied once the copy was looked for',
    !!freshCopy && freshCopy.foxThemeApplied === true, JSON.stringify(freshCopy));
  t('...with the defaults', !!stored(fresh.win) && stored(fresh.win).minVideoLength === '0');

  // ---- No copy, read late: the write made before the read is copied once it is read ----
  {
    const backup = new Map();
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = boot({ data: backup, log: [], idb: { gate } });
    // The app writes its settings (foxThemeApplied) 200 ms in, while the read waits.
    await wait(500);
    t('precondition (late empty read): written before the read, not copied yet',
      !!stored(page.win) && stored(page.win).foxThemeApplied === true && !backup.has(KEY), backup.get(KEY));
    release();
    await until(() => backup.has(KEY), 2000);
    const late = backup.has(KEY) ? JSON.parse(backup.get(KEY)) : null;
    t('late empty read: the write made before it is copied after it', !!late && late.foxThemeApplied === true,
      JSON.stringify(late));
  }

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

  // ---- Two owners of one account before the read, its write refused ----
  {
    // Before the read: a change with per-account off (no account loaded),
    // then per-account on and a change in the account. Its record survived
    // in localStorage and every write of it is refused (quota): the restore
    // merges both changes into it, the second over the first.
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20', removeUpscaledFormats: true })]
    ]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const refusing = { refused: 0 };
    const page = boot({
      data: backup, log: [], idb: { gate },
      storage: Object.assign({ [PROFILE_KEY]: JSON.stringify({ minVideoLength: '10', removeUpscaledFormats: true }) }, IDENTITY),
      setup: (w) => {
        const real = w.localStorage;
        const refuse = (key) => { if (key === PROFILE_KEY) { refusing.refused++; throw new Error('QuotaExceededError'); } };
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
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const input = (text) => {
      const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
        .find((l) => l.textContent.trim() === text);
      return label && label.querySelector('input');
    };
    const perAccount = input('Separate Settings for Each Account');
    t('precondition (two owners): per-account off before the read', !!perAccount && perAccount.checked === false);
    // The first owner: no account loaded.
    input('Skip AI-Upscaled Qualities').click();
    await wait(50);
    perAccount.click();
    await wait(100);
    // The second owner: the account, its Hide Videos Shorter Than one step on.
    const row = Array.prototype.slice.call(page.win.document.querySelectorAll('.shortcut-control-row'))
      .find((r) => r.querySelector('.shortcut-label').textContent.trim() === 'Hide Videos Shorter Than');
    const before = row.querySelector('.current-value').textContent;
    row.focus();
    trustedKey(page.win, 39, row);
    const after = row.querySelector('.current-value').textContent;
    t('precondition (two owners): the account\'s change made', after !== before, before + ' -> ' + after);
    await wait(300);
    release();
    await wait(800);
    t('...precondition: the account\'s record was refused', refusing.refused > 0, String(refusing.refused));
    const upscaled = input('Skip AI-Upscaled Qualities');
    t('two owners: the change made with no account loaded is kept', !!upscaled && upscaled.checked === false,
      String(upscaled && upscaled.checked));
    t('...and the account\'s own change too', await panelValue(page.win, 'Hide Videos Shorter Than') === after,
      await panelValue(page.win, 'Hide Videos Shorter Than'));
  }

  // ---- A switch of account while the copy is still being read ----
  {
    // Separate settings switched on and a setting changed in account abc,
    // then the TV moves to account xyz, all before the read: abc keeps its
    // change, xyz and the shared record do not take it.
    const PROFILE_B = KEY + '::' + hashString('accountId=xyz');
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, removeUpscaledFormats: true })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20', removeUpscaledFormats: true })],
      [PROFILE_B, JSON.stringify({ minVideoLength: '5', removeUpscaledFormats: true })]
    ]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = boot({ data: backup, log: [], storage: IDENTITY, idb: { gate } });
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const input = (text) => {
      const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
        .find((l) => l.textContent.trim() === text);
      return label && label.querySelector('input');
    };
    input('Separate Settings for Each Account').click();
    await wait(50);
    const upscaled = input('Skip AI-Upscaled Qualities');
    t('precondition (switch during the read): Skip AI-Upscaled Qualities is on', !!upscaled && upscaled.checked === true);
    upscaled.click();
    await until(() => !!stored(page.win, PROFILE_KEY) && stored(page.win, PROFILE_KEY).removeUpscaledFormats === false);
    page.win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: { accountId: 'xyz' } }));
    page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
    page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
    await wait(300);
    release();
    let switched = false;
    for (let i = 0; i < 60 && !switched; i++) {
      switched = await panelValue(page.win, 'Hide Videos Shorter Than') === '5 min';
      if (!switched) await wait(50);
    }
    t('switch during the read: once read, the account now in use is loaded', switched);
    t('...the account the change was made in keeps it', stored(page.win, PROFILE_KEY).removeUpscaledFormats === false &&
      stored(page.win, PROFILE_KEY).minVideoLength === '20', JSON.stringify(stored(page.win, PROFILE_KEY)));
    t('...the other account does not take it', stored(page.win, PROFILE_B).removeUpscaledFormats === true,
      JSON.stringify(stored(page.win, PROFILE_B)));
    t('...nor the shared record', stored(page.win).removeUpscaledFormats === true, JSON.stringify(stored(page.win)));
    const copied = await until(() => JSON.parse(backup.get(PROFILE_KEY)).removeUpscaledFormats === false, 2000);
    t('...and its copy gets the change, though another account is in use', copied, backup.get(PROFILE_KEY));
  }

  // ---- Separate settings on, a change in the account, off again: all before the read ----
  {
    // The account's change goes to its record though separate settings are
    // off once the copy is read: on again, the account has it.
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: false, foxThemeApplied: true, minVideoLength: '5' })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20', removeUpscaledFormats: true })]
    ]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = boot({ data: backup, log: [], storage: IDENTITY, idb: { gate } });
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const input = (text) => {
      const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
        .find((l) => l.textContent.trim() === text);
      return label && label.querySelector('input');
    };
    const perAccount = input('Separate Settings for Each Account');
    t('precondition (on, change, off): separate settings off, the copy not read yet', !!perAccount && perAccount.checked === false &&
      !!stored(page.win) && stored(page.win).minVideoLength === '0', JSON.stringify(stored(page.win)));
    perAccount.click();
    const upscaled = input('Skip AI-Upscaled Qualities');
    t('...precondition: on, in the account, Skip AI-Upscaled Qualities on', !!upscaled && upscaled.checked === true);
    upscaled.click();
    t('...precondition: the account’s record has the change before the read',
      await until(() => { const r = stored(page.win, PROFILE_KEY); return !!r && r.removeUpscaledFormats === false; }, 2000),
      JSON.stringify(stored(page.win, PROFILE_KEY)));
    input('Separate Settings for Each Account').click();
    t('...precondition: off again before the read', input('Separate Settings for Each Account').checked === false);
    release();
    const restored = await until(() => !!stored(page.win) && stored(page.win).minVideoLength === '5', 3000);
    t('...precondition: the copy was read', restored, JSON.stringify(stored(page.win)));
    const own = stored(page.win, PROFILE_KEY);
    t('on, change, off: the account’s record keeps the change, with its other settings from the copy',
      !!own && own.removeUpscaledFormats === false && own.minVideoLength === '20', JSON.stringify(own));
    input('Separate Settings for Each Account').click();
    const back = await until(() => { const i = input('Skip AI-Upscaled Qualities'); return !!i && i.checked === false; }, 2000);
    t('...and on again, the account has it', back, String(input('Skip AI-Upscaled Qualities') && input('Skip AI-Upscaled Qualities').checked));
  }

  // ---- A change after the restore, then a switch back with localStorage emptied ----
  {
    // The copy read at the start is older than a change made since: switched
    // away and back with the account's record gone from localStorage (YouTube
    // empties it at a sign-out), the account has its change, not the copy's.
    const PROFILE_B = KEY + '::' + hashString('accountId=xyz');
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })],
      [PROFILE_KEY, JSON.stringify({ removeUpscaledFormats: true })],
      [PROFILE_B, JSON.stringify({ removeUpscaledFormats: true })]
    ]);
    const page = boot({ data: backup, log: [], storage: IDENTITY });
    await until(() => !!stored(page.win, PROFILE_KEY), 3000);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const input = (text) => {
      const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
        .find((l) => l.textContent.trim() === text);
      return label && label.querySelector('input');
    };
    const upscaled = input('Skip AI-Upscaled Qualities');
    t('precondition (stale copy): restored, Skip AI-Upscaled Qualities is on', !!upscaled && upscaled.checked === true);
    upscaled.click();
    await until(() => stored(page.win, PROFILE_KEY).removeUpscaledFormats === false);
    const identity = (id) => {
      page.win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: { accountId: id } }));
      page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
      page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
    };
    identity('xyz');
    // The other account's own value (on) shows: the switch away happened.
    const away = await until(() => { const i = input('Skip AI-Upscaled Qualities'); return !!i && i.checked === true; }, 2000);
    t('precondition (stale copy): switched away, the other account\'s setting (on) shows', away);
    page.win.localStorage.removeItem(PROFILE_KEY);
    t('...precondition: the account\'s record is gone from localStorage', page.win.localStorage.getItem(PROFILE_KEY) === null);
    identity('abc');
    await until(() => { const i = input('Skip AI-Upscaled Qualities'); return !!i && i.checked === false; }, 2000);
    const now = input('Skip AI-Upscaled Qualities');
    t('stale copy: back in the account, its change since the restore, not the copy\'s value', !!now && now.checked === false,
      String(now && now.checked));
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

  // ---- A change made before a read that failed, then the next start ----
  {
    const backup = savedCopy([[KEY, JSON.stringify({ minVideoLength: '5', removeUpscaledFormats: true, foxThemeApplied: true })]]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = boot({ data: backup, log: [], idb: { gate, failAfter: 0 } });
    await wait(300);
    trustedKey(first.win, 404, first.win.document.body, 'keydown');
    trustedKey(first.win, 404, first.win.document.body, 'keyup');
    await until(() => first.win.document.querySelector('.ytaf-ui-container label'));
    const label = Array.prototype.slice.call(first.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
    const input = label && label.querySelector('input');
    t('precondition (change, failed read): the switch is on, from the defaults', !!input && input.checked === true);
    if (input) input.click();
    const written = await until(() => stored(first.win).removeUpscaledFormats === false);
    release();
    await wait(300);
    const left = {};
    for (let i = 0; i < first.win.localStorage.length; i++) {
      const k = first.win.localStorage.key(i);
      left[k] = first.win.localStorage.getItem(k);
    }
    t('...precondition: the change was stored, and the read failed (the mark stays)',
      written && left['ytaf-settings-recovering'] === '1' && JSON.parse(left[KEY]).removeUpscaledFormats === false, JSON.stringify(left));
    const log = [];
    const page = boot({ data: backup, log, storage: left });
    const restored = await until(() => stored(page.win).minVideoLength === '5');
    t('change, failed read: the next start restores the copy, with the change the failed run stored kept',
      restored && stored(page.win).removeUpscaledFormats === false, JSON.stringify(stored(page.win)));
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const inUse = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
    t('...it is the one in use', !!inUse && inUse.querySelector('input').checked === false);
    const copied = await until(() => JSON.parse(backup.get(KEY)).removeUpscaledFormats === false);
    t('...the copy gets it, with its other settings', copied && JSON.parse(backup.get(KEY)).minVideoLength === '5', backup.get(KEY));
    t('...and once read, nothing of it is left to replay',
      page.win.localStorage.getItem('ytaf-settings-changed') === null && page.win.localStorage.getItem('ytaf-settings-recovering') === null);
  }

  // ---- An account with no record anywhere, given a change before the copy was read ----
  {
    // The copy has only the shared settings: the account abc, turned on in
    // the read, has nothing to go by but the restored shared values.
    const backup = savedCopy([[KEY, JSON.stringify({ minVideoLength: '1', removeUpscaledFormats: true, foxThemeApplied: true })]]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const log = [];
    const page = boot({ data: backup, log, storage: IDENTITY, idb: { gate } });
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const input = (text) => {
      const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
        .find((l) => l.textContent.trim() === text);
      return label && label.querySelector('input');
    };
    const separate = input('Separate Settings for Each Account');
    const upscaled = input('Skip AI-Upscaled Qualities');
    t('precondition (no account record): separate settings off, Skip AI-Upscaled Qualities on',
      !!separate && separate.checked === false && !!upscaled && upscaled.checked === true);
    separate.click();
    upscaled.click();
    // Read before the debounced write: the account's record is not stored yet.
    release();
    const restored = await until(() => !!stored(page.win, PROFILE_KEY) && stored(page.win, PROFILE_KEY).minVideoLength === '1');
    t('no account record: the account starts from the restored shared settings',
      restored, JSON.stringify(stored(page.win, PROFILE_KEY)));
    t('...with the change made in it before the read', stored(page.win, PROFILE_KEY).removeUpscaledFormats === false &&
      upscaled.checked === false, `${JSON.stringify(stored(page.win, PROFILE_KEY))} ${upscaled.checked}`);
    t('...which the shared record does not take', stored(page.win).removeUpscaledFormats === true &&
      stored(page.win).perAccountSettings === true, JSON.stringify(stored(page.win)));
    const copied = await until(() => backup.has(PROFILE_KEY) && JSON.parse(backup.get(PROFILE_KEY)).removeUpscaledFormats === false);
    t('...and the account\'s copy has it', copied, backup.get(PROFILE_KEY));
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

  // ---- The caption style that comes back with the copy wins over YouTube's default ----
  // localStorage emptied: YouTube writes its default caption record while the
  // copy is still being read, and the app goes to the background meanwhile.
  {
    const CAPTION = 'yt-player-caption-display-settings';
    const STYLE = JSON.stringify({ color: '#ffff00' });
    const DEFAULT = JSON.stringify({ color: '#ffffff' });
    const backup = savedCopy([[KEY, JSON.stringify({ captionStyleBackup: { [CAPTION]: STYLE }, foxThemeApplied: true })]]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = boot({ data: backup, log: [], idb: { gate } });
    await wait(100);
    const now = Date.now();
    page.win.localStorage.setItem(CAPTION, JSON.stringify({ data: DEFAULT, expiration: now + 1000, creation: now }));
    Object.defineProperty(page.win.document, 'hidden', { value: true, configurable: true });
    page.win.document.dispatchEvent(new page.win.Event('visibilitychange'));
    Object.defineProperty(page.win.document, 'hidden', { value: false, configurable: true });
    await wait(300);
    const early = stored(page.win) && stored(page.win).captionStyleBackup;
    t('a caption record YouTube wrote before the copy was read is not copied as the style',
      !early || early[CAPTION] !== DEFAULT, JSON.stringify(early));
    release();
    await wait(400);
    const rec = JSON.parse(page.win.localStorage.getItem(CAPTION) || 'null');
    t('...once read, the style of the copy is written over the default of YouTube', !!rec && rec.data === STYLE, JSON.stringify(rec));
    t('...and stays the style kept in the settings', stored(page.win).captionStyleBackup[CAPTION] === STYLE,
      JSON.stringify(stored(page.win).captionStyleBackup));
  }

  // ---- The caption style is written back once localStorage takes it ----
  {
    const CAPTION = 'yt-player-caption-display-settings';
    const STYLE = JSON.stringify({ color: '#ffff00' });
    const DEFAULT = JSON.stringify({ color: '#ffffff' });
    const backup = savedCopy([[KEY, JSON.stringify({ captionStyleBackup: { [CAPTION]: STYLE }, foxThemeApplied: true })]]);
    let release;
    const gate = new Promise((r) => { release = r; });
    let refuse = false;
    let refused = 0;
    const page = boot({
      data: backup, log: [], idb: { gate },
      setup: (w) => {
        const setItem = w.Storage.prototype.setItem;
        w.Storage.prototype.setItem = function (k, v) {
          if (refuse && k === CAPTION) { refused++; throw new Error('QuotaExceededError'); }
          return setItem.call(this, k, v);
        };
      }
    });
    await wait(100);
    const now = Date.now();
    page.win.localStorage.setItem(CAPTION, JSON.stringify({ data: DEFAULT, expiration: now + 1000, creation: now }));
    refuse = true;
    release();
    // The restore's write-back is seen refused before writes are let through:
    // a write-back that came only after that would pass with no retry at all.
    const sawRefused = await until(() => refused > 0, 10000);
    t('precondition: the caption write-back at the restore was refused, YouTube’s default is still there',
      sawRefused && JSON.parse(page.win.localStorage.getItem(CAPTION)).data === DEFAULT, String(refused));
    refuse = false;
    Object.defineProperty(page.win.document, 'hidden', { value: true, configurable: true });
    page.win.document.dispatchEvent(new page.win.Event('visibilitychange'));
    Object.defineProperty(page.win.document, 'hidden', { value: false, configurable: true });
    await wait(100);
    const rec = JSON.parse(page.win.localStorage.getItem(CAPTION) || 'null');
    t('a caption write-back refused at the restore is made at the next look', !!rec && rec.data === STYLE, JSON.stringify(rec));
    t('...and the default is not copied as the style', stored(page.win).captionStyleBackup[CAPTION] === STYLE,
      JSON.stringify(stored(page.win).captionStyleBackup));
  }

  // ---- Reset of the statistics while the copy is still being read ----
  {
    // minVideoLength: a setting of the copy's own, to see that the read is over.
    const backup = savedCopy([[KEY, JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4, minVideoLength: '5', foxThemeApplied: true })]]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = boot({ data: backup, log: [], idb: { gate } });
    await wait(300);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    const button = await until(() => page.win.document.querySelector('.ytaf-sb-stats .ytaf-list-btn'));
    t('precondition (reset during the read): the Reset button is there', !!button);
    if (button) page.win.document.querySelector('.ytaf-sb-stats .ytaf-list-btn').click();
    release();
    const read = await until(() => !!stored(page.win) && stored(page.win).minVideoLength === '5', 3000);
    t('precondition (reset during the read): the copy was read', read, JSON.stringify(stored(page.win)));
    t('a Reset before the read is kept: the copy does not bring the totals back',
      stored(page.win).sbTimeSaved === 0 && stored(page.win).sbSkipCount === 0,
      JSON.stringify([stored(page.win).sbTimeSaved, stored(page.win).sbSkipCount]));
  }
  {
    // The counters already at zero, the start-up writes over, the read fails:
    // the reset alone must be stored, or the next start restores the old totals.
    const backup = savedCopy([[KEY, JSON.stringify({ sbTimeSaved: 100, sbSkipCount: 4, minVideoLength: '5', foxThemeApplied: true })]]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = boot({ data: backup, log: [], idb: { gate, failAfter: 0 } });
    await wait(1000);
    trustedKey(first.win, 404, first.win.document.body, 'keydown');
    trustedKey(first.win, 404, first.win.document.body, 'keyup');
    const button = await until(() => first.win.document.querySelector('.ytaf-sb-stats .ytaf-list-btn'));
    t('precondition (reset, failed read): the Reset button is there', !!button);
    if (button) first.win.document.querySelector('.ytaf-sb-stats .ytaf-list-btn').click();
    await wait(600);
    release();
    await wait(300);
    const left = {};
    for (let i = 0; i < first.win.localStorage.length; i++) {
      const k = first.win.localStorage.key(i);
      left[k] = first.win.localStorage.getItem(k);
    }
    const next = boot({ data: backup, log: [], storage: left });
    const nextRead = await until(() => !!stored(next.win) && stored(next.win).minVideoLength === '5', 3000);
    t('precondition (reset, failed read): the next start read the copy', nextRead, JSON.stringify(stored(next.win)));
    t('a Reset of counters already at zero survives a failed read',
      stored(next.win).sbTimeSaved === 0 && stored(next.win).sbSkipCount === 0,
      JSON.stringify([stored(next.win).sbTimeSaved, stored(next.win).sbSkipCount]));
  }

  // ---- A write of the copy that aborts ----
  {
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, minVideoLength: '1' })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '2' })]
    ]);
    const before = [backup.get(KEY), backup.get(PROFILE_KEY)];
    const writes = [];
    const txIds = [];
    boot({
      config: { perAccountSettings: true, foxThemeApplied: true, minVideoLength: '5' },
      storage: Object.assign({ [PROFILE_KEY]: JSON.stringify({ minVideoLength: '20' }) }, IDENTITY),
      data: backup, log: writes, idb: { abortWrites: true, txIds }
    });
    await wait(1800);
    t('precondition (aborted write): both records were in it',
      writes.includes('aborted put ' + KEY) && writes.includes('aborted put ' + PROFILE_KEY), writes.join());
    const txOf = (key) => { const w = txIds.find(([note]) => note === 'put ' + key); return w ? w[1] : null; };
    t('...precondition: both records in one transaction', txOf(KEY) !== null && txOf(KEY) === txOf(PROFILE_KEY), JSON.stringify(txIds));
    t('an aborted write leaves both records of the copy as they were',
      backup.get(KEY) === before[0] && backup.get(PROFILE_KEY) === before[1], `${backup.get(KEY)} ${backup.get(PROFILE_KEY)}`);
  }

  // ---- An account record written before a read that failed, then the next start ----
  {
    const backup = savedCopy([
      [KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true, minVideoLength: '1' })],
      [PROFILE_KEY, JSON.stringify({ minVideoLength: '20' })]
    ]);
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = boot({ data: backup, log: [], storage: IDENTITY, idb: { gate, failAfter: 0 } });
    await wait(300);
    trustedKey(first.win, 404, first.win.document.body, 'keydown');
    trustedKey(first.win, 404, first.win.document.body, 'keyup');
    await until(() => first.win.document.querySelector('.ytaf-ui-container label'));
    const label = Array.prototype.slice.call(first.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Separate Settings for Each Account');
    if (label) label.querySelector('input').click();
    const seeded = await until(() => !!stored(first.win, PROFILE_KEY));
    release();
    await wait(300);
    const left = {};
    for (let i = 0; i < first.win.localStorage.length; i++) {
      const k = first.win.localStorage.key(i);
      left[k] = first.win.localStorage.getItem(k);
    }
    t('precondition (seeded, failed read): the account record from the defaults is left, with the mark',
      seeded && left['ytaf-settings-recovering'] === '1' && JSON.parse(left[PROFILE_KEY]).minVideoLength === '0',
      JSON.stringify(left));
    const page = boot({ data: backup, log: [], storage: left });
    let restored = false;
    for (let i = 0; i < 60 && !restored; i++) {
      restored = await panelValue(page.win, 'Hide Videos Shorter Than') === '20 min';
      if (!restored) await wait(50);
    }
    t('the next start still takes the copy over the record written from the defaults',
      restored && stored(page.win, PROFILE_KEY).minVideoLength === '20', JSON.stringify(stored(page.win, PROFILE_KEY)));
    t('...the copy is not overwritten with the defaults', JSON.parse(backup.get(PROFILE_KEY)).minVideoLength === '20', backup.get(PROFILE_KEY));
    t('...and once read, no mark is left', page.win.localStorage.getItem('ytaf-settings-seeded') === null &&
      page.win.localStorage.getItem('ytaf-settings-recovering') === null);
  }

  // ---- A database that fails to open once: the next write tries again ----
  {
    const data = new Map();
    const log = [];
    const idb = { openFails: 1 };
    const page = boot({ config: { minVideoLength: '5', foxThemeApplied: true }, data, log, idb });
    // The copy at the start asked for the database, and that open failed.
    const tried = await until(() => idb.opened >= 1, 3000);
    await wait(50);
    t('open failing once: precondition: the copy at the start tried and did not get through', tried && !data.has(KEY),
      `${idb.opened} ${JSON.stringify(Array.from(data.keys()))}`);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await wait(300);
    const box = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
    if (box) box.querySelector('input').click();
    await wait(400);
    const copy = data.has(KEY) ? JSON.parse(data.get(KEY)) : null;
    t('open failing once: a later change opens it again and is copied',
      !!box && idb.opened >= 2 && !!copy && copy.removeUpscaledFormats === false && copy.minVideoLength === '5', `${idb.opened} ${JSON.stringify(copy)}`);
  }

  // ---- A blocked open that gets through later ----
  {
    // Given up when blocked, the next write opens again; the blocked one,
    // getting through after all, is closed, not left open beside it.
    const data = new Map();
    const idb = { blockFirst: true };
    const page = boot({ config: { minVideoLength: '5', foxThemeApplied: true }, data, log: [], idb });
    const late = await until(() => idb.opened >= 1 && idb.closed === 1, 3000);
    t('blocked open: the connection that got through late is closed', late, `${idb.opened} ${idb.closed}`);
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const box = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Skip AI-Upscaled Qualities');
    if (box) box.querySelector('input').click();
    const copied = await until(() => data.has(KEY) && JSON.parse(data.get(KEY)).removeUpscaledFormats === false, 3000);
    t('...and a later write opens again and is copied', copied && idb.opened >= 2, `${idb.opened} ${data.get(KEY)}`);
  }

  // ---- A read of the copy with no answer: the restore gives up, a switch of account works ----
  {
    // A recovery start (the mark left by a run whose read failed) with
    // separate settings on, and a database that never answers the read.
    const PROFILE_B = KEY + '::' + hashString('accountId=xyz');
    const storage = Object.assign({}, IDENTITY, {
      'ytaf-settings-recovering': '1',
      [KEY]: JSON.stringify({ perAccountSettings: true, foxThemeApplied: true }),
      [PROFILE_KEY]: JSON.stringify({ minVideoLength: '20' }),
      [PROFILE_B]: JSON.stringify({ minVideoLength: '5' })
    });
    const backup = savedCopy([[KEY, JSON.stringify({ perAccountSettings: true, foxThemeApplied: true })]]);
    // The read's 10 s timeout and the selector's two later looks (1.5 s and
    // 5 s) are held and run by hand: no real waits, and each is seen leaving
    // the account alone while the read is pending.
    let timeout = null;
    let holdLooks = false;
    const looks = [];
    const page = boot({
      data: backup, log: [], storage, idb: { gate: new Promise(() => {}) },
      setup: (w) => {
        const realTimeout = w.setTimeout.bind(w);
        w.setTimeout = (fn, ms, ...args) => {
          if (!timeout && ms === 10000 && typeof fn === 'function' && String(fn).indexOf('timed out') !== -1) { timeout = fn; return -11; }
          if (holdLooks && (ms === 1500 || ms === 5000)) { looks.push({ ms, fn }); return -20 - looks.length; }
          return realTimeout(fn, ms, ...args);
        };
      }
    });
    t('no answer: precondition: the account at the start has its settings', await panelValue(page.win, 'Hide Videos Shorter Than') === '20 min',
      await panelValue(page.win, 'Hide Videos Shorter Than'));
    await until(() => !!timeout, 3000);
    t('no answer: precondition: the read has its timeout set', !!timeout);
    page.win.localStorage.setItem('yt.leanback.default::last-identity-used', JSON.stringify({ data: { accountId: 'xyz' } }));
    holdLooks = true;
    page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: true } }));
    page.win.dispatchEvent(new page.win.CustomEvent('ytaf-page-update', { detail: { isAccountSelector: false } }));
    holdLooks = false;
    t('no answer: precondition: leaving the selector set its two later looks',
      looks.map((l) => l.ms).join(',') === '1500,5000', looks.map((l) => l.ms).join(','));
    t('no answer: before the timeout, the switch waits for the read', await panelValue(page.win, 'Hide Videos Shorter Than') === '20 min',
      await panelValue(page.win, 'Hide Videos Shorter Than'));
    for (const look of looks) look.fn();
    t('...and so do the two later looks, run while the read is pending',
      await panelValue(page.win, 'Hide Videos Shorter Than') === '20 min', await panelValue(page.win, 'Hide Videos Shorter Than'));
    // No selector event and no look left: only the timeout can load the account now.
    if (timeout) timeout();
    let switched = false;
    for (let i = 0; i < 40 && !switched; i++) {
      switched = await panelValue(page.win, 'Hide Videos Shorter Than') === '5 min';
      if (!switched) await wait(50);
    }
    t('no answer: the read gives up, and a switch of account loads that account', switched);
    t('...the mark stays for the next start', page.win.localStorage.getItem('ytaf-settings-recovering') === '1');
  }

  // ---- A connection the browser closes: a later write opens again ----
  // drop: closed with onclose (storage cleared, say); lose: its transactions
  // just throw (InvalidStateError), with no event.
  for (const how of ['drop', 'lose']) {
    const data = new Map();
    const conns = [];
    const page = boot({ config: { minVideoLength: '5', foxThemeApplied: true }, data, log: [], idb: { conns } });
    await until(() => data.has(KEY), 5000);
    t('closed (' + how + '): precondition: the stored settings were copied over one connection',
      conns.length === 1 && data.has(KEY) && JSON.parse(data.get(KEY)).minVideoLength === '5', String(conns.length));
    conns[0][how]();
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const input = (text) => {
      const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
        .find((l) => l.textContent.trim() === text);
      return label && label.querySelector('input');
    };
    input('Remove Mixes').click();
    if (how === 'lose') {
      // The first write after finds the connection gone, and forgets it.
      await until(() => stored(page.win).removeMixes === true, 2000);
      await wait(100);
      t('closed (lose): precondition: the write on the lost connection did not land', conns.length === 1 &&
        JSON.parse(data.get(KEY)).removeMixes !== true, data.get(KEY));
      input('Hide Repeated Videos').click();
    }
    const copied = await until(() => JSON.parse(data.get(KEY)).removeMixes === true, 3000);
    t('closed (' + how + '): the next write opens the database again and is copied', copied && conns.length === 2,
      conns.length + ' ' + data.get(KEY));
  }

  // ---- An open that never answers: each write waits for it no longer than the read would ----
  {
    const data = new Map();
    let openRelease;
    const openGate = new Promise((r) => { openRelease = r; });
    const deadlines = [];
    const conns = [];
    const page = boot({
      config: { minVideoLength: '5', foxThemeApplied: true }, data, log: [], idb: { openGate, conns },
      setup: (w) => {
        const realTimeout = w.setTimeout.bind(w);
        w.setTimeout = (fn, ms, ...args) => {
          if (ms === 10000 && typeof fn === 'function' && String(fn).indexOf('timed out') !== -1) {
            deadlines.push(fn);
            return -30 - deadlines.length;
          }
          return realTimeout(fn, ms, ...args);
        };
      }
    });
    await until(() => deadlines.length === 1, 4000);
    t('open with no answer: precondition: the start’s copy waits for it with a deadline', deadlines.length === 1,
      String(deadlines.length));
    trustedKey(page.win, 404, page.win.document.body, 'keydown');
    trustedKey(page.win, 404, page.win.document.body, 'keyup');
    await until(() => page.win.document.querySelector('.ytaf-ui-container label'));
    const label = Array.prototype.slice.call(page.win.document.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === 'Remove Mixes');
    label.querySelector('input').click();
    await until(() => deadlines.length === 2, 2000);
    t('open with no answer: a write meanwhile has its own deadline', deadlines.length === 2, String(deadlines.length));
    for (const fire of deadlines) fire();
    openRelease();
    await until(() => conns.length === 1, 2000);
    await wait(100);
    t('open with no answer: the writes it gave up on are not made once the open answers', conns.length === 1 && !data.has(KEY),
      String(data.get(KEY)));
    label.querySelector('input').click();
    const later = await until(() => data.has(KEY) && JSON.parse(data.get(KEY)).removeMixes === false, 3000);
    t('...and a write after it is copied, the whole record', later && JSON.parse(data.get(KEY)).minVideoLength === '5',
      String(data.get(KEY)));
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
  await until(() => !!stored(noneEmpty.win), 3000);
  t('...nor with localStorage empty', noneEmpty.errors.length === 0, noneEmpty.errors[0]);
  t('...precondition: the start wrote its settings', !!stored(noneEmpty.win) && stored(noneEmpty.win).foxThemeApplied === true,
    JSON.stringify(stored(noneEmpty.win)));
  // No IndexedDB is no failed read: nothing is left for the next start to recover.
  t('...and the recovery mark is gone, as after an empty copy', noneEmpty.win.localStorage.getItem('ytaf-settings-recovering') === null,
    noneEmpty.win.localStorage.getItem('ytaf-settings-recovering'));
});
