/**
 * Per-account settings (perAccountSettings).
 *
 * Each account's own settings live in `ytaf-configuration::<profile>`; the
 * device settings stay in `ytaf-configuration`. Checks a new account starts
 * from the shared settings, a token refresh keeps the profile, switching
 * account on the selector swaps the settings live, an unrecognised identity
 * falls back to the shared settings and reports only field names, and that
 * with the option off nothing but the shared store is written.
 *
 * Usage: node bench/per-account-test.cjs [dist/webOSUserScripts/userScript.js] [legacy|modern]
 */
const { createReporter, bootPage, trustedKey: key, wait } = require('./harness.cjs');

const GREEN = 404;
const CONFIG_KEY = 'ytaf-configuration';
const IDENTITY_KEY = 'yt.leanback.default::last-identity-used';
const RYD = 'Return YouTube Dislike';

function boot(shared, identity, extraStorage = {}) {
  let NS;
  // With `holdRechecks.on`, the account rechecks the selector schedules after
  // a choice (at 1500 and 5000 ms, config.js) are held here for the test to run.
  const holdRechecks = { on: false, held: [] };
  const { win, errors, frames } = bootPage({
    raf: 'manual',
    consoleErrors: false,
    // The legacy environment has no Element#remove here.
    restoreRemove: false,
    // Before the environment of the build is applied: on the legacy build
    // this fetch is taken away with jsdom's, and the bundle's polyfill runs.
    setup: (w) => {
      w.fetch = () => Promise.reject(new Error('offline'));
      const realSetTimeout = w.setTimeout;
      w.setTimeout = function (fn, ms, ...rest) {
        if (holdRechecks.on && (ms === 1500 || ms === 5000)) {
          holdRechecks.held.push({ fn, ms });
          return 0;
        }
        return realSetTimeout.call(this, fn, ms, ...rest);
      };
      NS = w.JSON.stringify;
      // A string is stored as it is (a broken set); null stores nothing (a first start).
      if (shared !== null) w.localStorage.setItem(CONFIG_KEY, typeof shared === 'string' ? shared : NS(Object.assign({
        enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
        enableReturnYouTubeDislike: false, thumbnailQuality: 'off', enableAutoLogin: false
      }, shared)));
      if (identity) w.localStorage.setItem(IDENTITY_KEY, NS({ data: identity }));
      for (const [k, v] of Object.entries(extraStorage)) w.localStorage.setItem(k, NS(v));
    }
  });
  const pump = () => { for (let i = 0; i < 10; i++) frames.pump(); };
  return { win, NS, errors, pump, holdRechecks };
}

function checkbox(win, text) {
  for (const label of win.document.querySelectorAll('.ytaf-ui-container label')) {
    const span = label.querySelector('.label-text');
    if (span && span.textContent === text) return label.querySelector('input');
  }
  return null;
}

function toggle(win, input) {
  input.checked = !input.checked;
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
}

const profileKeys = (win) => {
  const out = [];
  for (let i = 0; i < win.localStorage.length; i++) {
    const k = win.localStorage.key(i);
    if (k.indexOf(CONFIG_KEY + '::') === 0) out.push(k);
  }
  return out.sort();
};
const read = (win, k) => JSON.parse(win.localStorage.getItem(k));

async function chooseAccount(win, identity) {
  win.document.body.className = 'WEB_PAGE_TYPE_ACCOUNT_SELECTOR';
  await wait(20);
  win.localStorage.setItem(IDENTITY_KEY, JSON.stringify({ data: identity }));
  win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
  await wait(20);
}

const { t, run } = createReporter();

const ACCOUNT_A = { identityType: 'SIGNED_IN', obfuscatedGaiaId: '1111', accessToken: 'tok-a1' };
const ACCOUNT_B = { identityType: 'SIGNED_IN', obfuscatedGaiaId: '2222', accessToken: 'tok-b1' };

run(async () => {
  // ---- Option off: one shared store, as before ----
  {
    const { win, errors } = boot({ perAccountSettings: false }, ACCOUNT_A);
    key(win, GREEN);
    toggle(win, checkbox(win, RYD));
    await wait(300);
    t('off: no profile store is written', profileKeys(win).length === 0, profileKeys(win).join());
    t('off: change lands in the shared store', read(win, CONFIG_KEY).enableReturnYouTubeDislike === true);
    t('off: no errors', errors.length === 0, errors.join(' | '));
  }

  // ---- Option on: new account seeded from the shared settings ----
  {
    const { win, errors, pump } = boot({ perAccountSettings: true, enableReturnYouTubeDislike: true }, ACCOUNT_A);
    await wait(300);
    const keys = profileKeys(win);
    t('on: a profile store is created for the account', keys.length === 1, keys.join());
    const profileA = keys[0];
    t('on: profile name carries no account id or token',
      profileA && profileA.indexOf('1111') === -1 && win.localStorage.getItem(profileA).indexOf('tok-') === -1);
    const storedA = read(win, profileA);
    t('on: new profile starts from the shared settings', storedA.enableReturnYouTubeDislike === true);
    t('on: device settings stay out of the profile',
      !('enableAutoLogin' in storedA) && !('perAccountSettings' in storedA) && !('forceVideoCodec' in storedA));

    key(win, GREEN);
    pump();
    const status = win.document.querySelector('.ytaf-profile-status');
    t('on: panel says the account has its own settings', status && /own settings/.test(status.textContent), status && status.textContent);

    // Account B picks its own value.
    await chooseAccount(win, ACCOUNT_B);
    t('switch: B starts from the shared settings', checkbox(win, RYD).checked === true);
    toggle(win, checkbox(win, RYD));
    await wait(300);
    const keys2 = profileKeys(win);
    t('switch: B gets a store of its own', keys2.length === 2, keys2.join());
    const profileB = keys2.find((k) => k !== profileA);
    t('switch: B\'s change lands in B\'s store', read(win, profileB).enableReturnYouTubeDislike === false);
    t('switch: A\'s store is untouched', read(win, profileA).enableReturnYouTubeDislike === true);
    t('switch: shared store keeps its own value', read(win, CONFIG_KEY).enableReturnYouTubeDislike === true);

    // Back to A, with a refreshed token: same profile, A's value back live.
    await chooseAccount(win, Object.assign({}, ACCOUNT_A, { accessToken: 'tok-a2' }));
    t('switch back: A\'s value is applied live', checkbox(win, RYD).checked === true);
    t('token refresh: no third profile', profileKeys(win).length === 2, profileKeys(win).join());

    await chooseAccount(win, ACCOUNT_B);
    t('switch: B\'s value is applied live', checkbox(win, RYD).checked === false);
    t('on: no errors', errors.length === 0, errors.join(' | '));
  }

  // ---- Existing profile wins over the shared settings at startup ----
  {
    const first = boot({ perAccountSettings: true }, ACCOUNT_A);
    await wait(300);
    const profileA = profileKeys(first.win)[0];
    const { win } = boot({ perAccountSettings: true, enableReturnYouTubeDislike: false }, ACCOUNT_A,
      { [profileA]: { enableReturnYouTubeDislike: true } });
    key(win, GREEN);
    t('startup: the account\'s stored value is loaded', checkbox(win, RYD).checked === true);
  }

  // ---- Identity with no id: shared settings, field names reported ----
  {
    const { win, errors, pump } = boot({ perAccountSettings: true }, { identityType: 'SIGNED_IN', accessToken: 'secret-token' });
    await wait(300);
    t('unknown: no profile store', profileKeys(win).length === 0, profileKeys(win).join());
    key(win, GREEN);
    pump();
    const status = win.document.querySelector('.ytaf-profile-status');
    const text = status ? status.textContent : '';
    t('unknown: panel reports the field names', /not recognised/.test(text) && /identityType, accessToken/.test(text), text);
    t('unknown: panel shows no field values', text.indexOf('secret-token') === -1);
    t('unknown: no errors', errors.length === 0, errors.join(' | '));
  }

  // ---- Guest mode: a profile of its own that is never stored ----
  {
    const { win } = boot({ perAccountSettings: false, enableReturnYouTubeDislike: true },
      { identityType: 'UNAUTHENTICATED_IDENTITY_TYPE_GUEST' });
    key(win, GREEN);
    toggle(win, checkbox(win, 'Separate Settings for Each Account'));
    await wait(300);
    t('turn on as guest: no guest profile stored', profileKeys(win).length === 0, profileKeys(win).join());
    t('turn on: the shared values stay', read(win, CONFIG_KEY).enableReturnYouTubeDislike === true);
    t('turn on: flag saved in the shared store', read(win, CONFIG_KEY).perAccountSettings === true);
  }
  {
    // What an earlier build stored for the guest goes; the session starts from
    // the shared settings and what it changes is not kept.
    const GUEST = { identityType: 'UNAUTHENTICATED_IDENTITY_TYPE_GUEST' };
    const { win, errors, pump, holdRechecks } = boot({ perAccountSettings: true, enableReturnYouTubeDislike: true },
      GUEST, { [CONFIG_KEY + '::guest']: { enableReturnYouTubeDislike: false } });
    await wait(300);
    t('guest: an old guest profile is removed', win.localStorage.getItem(CONFIG_KEY + '::guest') === null);
    key(win, GREEN);
    pump();
    const status = win.document.querySelector('.ytaf-profile-status');
    const statusText = () => (status ? status.textContent : '');
    t('guest: panel says the guest\'s changes are not kept',
      statusText() === 'Guest: starts from the shared settings each time, changes are not kept', statusText());
    const ryd = checkbox(win, 'Return YouTube Dislike');
    t('guest: starts from the shared settings', !!ryd && ryd.checked === true);
    toggle(win, ryd);
    await wait(300);
    t('guest: a change is not stored', profileKeys(win).length === 0 && read(win, CONFIG_KEY).enableReturnYouTubeDislike === true,
      profileKeys(win).join() + ' shared=' + read(win, CONFIG_KEY).enableReturnYouTubeDislike);

    // The guest chosen again on the selector: the same session goes on, with
    // its change, and no profile change is told.
    // The selector's rechecks of the account chosen (1500 and 5000 ms) are
    // held and run by the test, so they are part of what is counted.
    const runRechecks = () => {
      const held = holdRechecks.held.splice(0);
      for (const h of held) h.fn();
      return held.map((h) => h.ms).sort((a, b) => a - b).join();
    };
    let profileChanges = 0;
    win.addEventListener('ytaf-profile-change', () => { profileChanges++; });
    holdRechecks.on = true;
    await chooseAccount(win, GUEST);
    t('guest chosen again: at once, the session keeps its change and no profile change is told',
      ryd.checked === false && profileChanges === 0, 'checked=' + ryd.checked + ' profile changes=' + profileChanges);
    const guestRechecks = runRechecks();
    t('guest chosen again: the session keeps its change, also after the selector\'s two rechecks',
      guestRechecks === '1500,5000' && ryd.checked === false && profileChanges === 0,
      'rechecks=' + guestRechecks + ' checked=' + ryd.checked + ' profile changes=' + profileChanges);
    // Then an account: the switch does happen, from the shared settings.
    await chooseAccount(win, ACCOUNT_A);
    // At once, as the selector is left: before any recheck has run.
    t('...an account chosen next: its settings are applied live at once, with one profile change',
      ryd.checked === true && profileChanges === 1 && statusText() === 'Using this account\'s own settings',
      'checked=' + ryd.checked + ' profile changes=' + profileChanges + ' ' + statusText());
    const accountRechecks = runRechecks();
    holdRechecks.on = false;
    t('...and still one profile change once its two rechecks ran',
      accountRechecks === '1500,5000' && ryd.checked === true && profileChanges === 1 &&
      statusText() === 'Using this account\'s own settings',
    'rechecks=' + accountRechecks + ' checked=' + ryd.checked + ' profile changes=' + profileChanges + ' ' + statusText());
    t('guest: no errors', errors.length === 0, errors.join(' | '));
  }

  // ---- A stored set that is not JSON ----
  {
    // Cut off mid-write: the app starts on the defaults, and the next change
    // writes a whole set over it - the same set a first start writes for the
    // same change.
    const fresh = boot(null, ACCOUNT_A);
    key(fresh.win, GREEN);
    toggle(fresh.win, checkbox(fresh.win, RYD));
    await wait(300);
    const want = read(fresh.win, CONFIG_KEY);
    const { win, errors } = boot('{"enableAdBlock":true,"enableSponsor', ACCOUNT_A);
    key(win, GREEN);
    const box = checkbox(win, RYD);
    const shownDefault = !!box && box.checked === false;
    toggle(win, box);
    await wait(300);
    let saved;
    try { saved = read(win, CONFIG_KEY); } catch { saved = null; }
    const keys = (o) => Object.keys(o).sort().join();
    t('broken stored set: the panel opens on the defaults', shownDefault);
    t('precondition: a first start writes a whole set with the change', !!want && want.enableReturnYouTubeDislike === true &&
      Object.keys(want).length > 50, want && Object.keys(want).length);
    t('broken stored set: the next change writes the whole set a first start writes',
      !!saved && keys(saved) === keys(want) && Object.keys(want).every((k) => JSON.stringify(saved[k]) === JSON.stringify(want[k])),
      win.localStorage.getItem(CONFIG_KEY));
    t('broken stored set: no errors', errors.length === 0, errors.join(' | '));
  }

  {
    // Storage that refuses the read (SecurityError): the settings load as defaults, the rest of the app runs.
    const { win, errors } = bootPage({
      raf: 'manual',
      consoleErrors: false,
      restoreRemove: false,
      setup: (w) => {
        w.fetch = () => Promise.reject(new Error('offline'));
        const getItem = w.Storage.prototype.getItem;
        Object.defineProperty(w.Storage.prototype, 'getItem', { configurable: true, value: function (k) {
          if (String(k).indexOf(CONFIG_KEY) === 0) { const e = new Error('Storage denied'); e.name = 'SecurityError'; throw e; }
          return getItem.call(this, k);
        } });
      }
    });
    await wait(100);
    key(win, GREEN);
    await wait(100);
    t('storage that refuses the read: the panel opens', !!checkbox(win, RYD));
    t('...with no errors', errors.length === 0, errors.join(' | '));
  }
});
