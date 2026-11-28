import { configRead, configAddChangeListener } from './config.js';
import { SELECTORS, REMOTE_KEYS, isGuestMode, sendKey, invalidateGuestModeCache } from './utils';
import { ResolveCommandRegistry } from './app_api/index';
import './auto-login.css';

const STORAGE_KEY = 'yt.leanback.default::recurring_actions';
const TARGET_ACTIONS = [
  'startup-screen-account-selector-with-guest',
  'whos_watching_fullscreen_zero_accounts',
  'startup-screen-signed-out-welcome-back'
];

const BYPASS_BODY_CLASS = 'ytaf-bypassing-login';
// The selector is bypassed on its own only this long after the start, or after
// a relaunch; later, opening it is the viewer's choice.
const BYPASS_WINDOW_MS = 15000;
// Until when that is: closed by the bypass itself, so it happens once.
let bypassUntil = Date.now() + BYPASS_WINDOW_MS;
let pageObserverAttached = false;

const WHOS_WATCHING_SHIFT_MS = 7 * 24 * 60 * 60 * 1000;
const ALWAYS_ASK_REFRESH_MS = 60 * 1000;
let alwaysAskTimer = null;

/**
 * Disables "Who's watching" by pushing the lastFired date 7 days into the future.
 * Credit: reisxd || https://github.com/reisxd/TizenTube/
 */
function disableWhosWatching(enable = true) {
  // Use a future date if enabling, or Date.now() if disabling
  const targetDate = enable ? Date.now() + WHOS_WATCHING_SHIFT_MS : Date.now();
  if (setWhosWatchingLastFired(targetDate)) {
    console.info(`Auto login: "Who's watching" screens ${enable ? 'disabled' : 'enabled'}`);
  }
}

/**
 * Makes "Who's watching" show on every launch by dating lastFired 7 days into
 * the past, so the app always considers it due. The app stamps lastFired itself
 * when the screen fires, so the value is re-applied every minute while active.
 * Same approach as TizenTube's "Permanently enable Who's Watching" option.
 */
function setAlwaysAskWhosWatching(enable) {
  if (alwaysAskTimer) {
    clearInterval(alwaysAskTimer);
    alwaysAskTimer = null;
  }
  if (!enable) return;

  const apply = () => setWhosWatchingLastFired(Date.now() - WHOS_WATCHING_SHIFT_MS);
  if (apply()) console.info('[Auto Login] "Who\'s watching" will be shown on every launch');
  alwaysAskTimer = setInterval(apply, ALWAYS_ASK_REFRESH_MS);
}

// Returns true if any of the account selector records were updated.
function setWhosWatchingLastFired(targetDate) {
  try {
    const storedData = localStorage.getItem(STORAGE_KEY);
    if (!storedData) {
      console.warn('Auto login: No recurring actions found');
      return false;
    }

    const json = JSON.parse(storedData);
    const actions = json.data?.data;

    if (!actions) return false;

    let isModified = false;

    for (const key of TARGET_ACTIONS) {
      if (actions[key]) {
        actions[key].lastFired = targetDate;
        isModified = true;
      }
    }

    if (isModified) localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
    return isModified;
  } catch (error) {
    console.error('Auto login: Failed to update settings:', error);
    return false;
  }
}

/**
 * Suppresses the Premium / Premium Lite upsell interstitial.
 *
 * Same trick as disableWhosWatching() above, against the app's own gate. The
 * leanback client records when it last showed the promo and how many times, and
 * consults both before showing it again:
 *
 *   yt.leanback.default::promo-coupon-shown-timestamp  {"data":0,...}
 *   yt.leanback.default::promo-coupon-shown-times      {"data":0,...}
 *
 * Dating the timestamp forward and raising the count means the app decides for
 * itself not to show the page - so there is no request to intercept, no empty
 * screen where the ad used to be, and nothing to go stale when YouTube moves
 * the endpoint or renames the page type.
 */
const PROMO_SUFFIXES = ['promo-coupon-shown-timestamp', 'promo-coupon-shown-times'];
const LEANBACK_PREFIX = 'yt.leanback.default::';
// Longer than the 7 days used for the account selector, which only has to
// survive until the next launch. A promo check can happen mid-session, and a TV
// app can stay open for weeks.
const PROMO_SUPPRESS_MS = 365 * 24 * 60 * 60 * 1000;
const PROMO_SHOWN_TIMES = 99;
// The app stamps these records to expire about 360 days out. An expired record
// reads back as absent, which would quietly hand the promo a clean slate, so
// the envelope's own TTL is refreshed alongside the value.
const PROMO_ENVELOPE_TTL_MS = 360 * 24 * 60 * 60 * 1000;

function promoValueFor(suffix) {
  return suffix === 'promo-coupon-shown-times'
    ? PROMO_SHOWN_TIMES
    : Date.now() + PROMO_SUPPRESS_MS;
}

function disablePromoUpsell(enable = true) {
  try {
    const targets = new Set();

    // Matched on the suffix rather than the full key: the namespace is not
    // always `default`, and a record written under a profile-specific one would
    // otherwise be missed while the promo kept firing.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      for (const suffix of PROMO_SUFFIXES) {
        if (key.slice(-suffix.length) === suffix) targets.add(key);
      }
    }

    // On a fresh install neither record exists yet, so seed the default
    // namespace - otherwise the very first launch is the one that gets nagged.
    for (const suffix of PROMO_SUFFIXES) targets.add(LEANBACK_PREFIX + suffix);

    let count = 0;
    for (const key of targets) {
      let suffix = null;
      for (const candidate of PROMO_SUFFIXES) {
        if (key.slice(-candidate.length) === candidate) suffix = candidate;
      }
      if (!suffix) continue;

      let envelope = null;
      const existing = localStorage.getItem(key);
      if (existing) {
        try {
          envelope = JSON.parse(existing);
        } catch {
          envelope = null;
        }
      }
      if (!envelope || typeof envelope !== 'object') {
        envelope = { data: 0, creation: Date.now() };
      }

      // Only `data` is ours to decide; the rest of the record is left as the
      // app wrote it, apart from the refreshed expiry.
      envelope.data = enable ? promoValueFor(suffix) : 0;
      envelope.expiration = Date.now() + PROMO_ENVELOPE_TTL_MS;
      localStorage.setItem(key, JSON.stringify(envelope));
      count++;
    }

    if (count) console.info(`[Auto Login] Premium upsell ${enable ? 'suppressed' : 'restored'} (${count} records)`);
  } catch (error) {
    console.error('[Auto Login] Failed to update promo settings:', error);
  }
}

const INLINE_PLAYBACK_KEY = 'yt.leanback.default::inline-playback-enabled';
// YouTube's own record as it was before Video Previews first forced it
// ({ value: the raw record, or null for none}), put back on Default.
const INLINE_PLAYBACK_SAVED_KEY = 'ytaf-inline-playback-saved';

function restoreInlinePlayback() {
  try {
    const saved = localStorage.getItem(INLINE_PLAYBACK_SAVED_KEY);
    if (saved === null) return;
    let value = null;
    try {
      value = JSON.parse(saved).value;
    } catch {
      value = null;
    }
    if (typeof value === 'string') localStorage.setItem(INLINE_PLAYBACK_KEY, value);
    else localStorage.removeItem(INLINE_PLAYBACK_KEY);
    // Only once YouTube's record is back: a refused write keeps the backup
    // for the next Default.
    localStorage.removeItem(INLINE_PLAYBACK_SAVED_KEY);
    console.info('[Auto Login] Inline playback (previews) given back to YouTube\'s own setting');
  } catch (error) {
    console.error('[Auto Login] Failed to restore inline playback setting:', error);
  }
}

/** Video Previews' part in YouTube's own setting: Off forces it off, Without and With sound on. */
export function setInlinePlayback(mode) {
  if (mode === 'default') {
    restoreInlinePlayback();
    return;
  }

  const isEnabled = mode !== 'off';
  try {
    if (localStorage.getItem(INLINE_PLAYBACK_SAVED_KEY) === null) {
      localStorage.setItem(INLINE_PLAYBACK_SAVED_KEY, JSON.stringify({ value: localStorage.getItem(INLINE_PLAYBACK_KEY) }));
    }
    localStorage.setItem(INLINE_PLAYBACK_KEY, JSON.stringify({ data: isEnabled }));
    console.info(`[Auto Login] Inline playback (previews) forced to: ${isEnabled}`);
  } catch (error) {
    console.error('[Auto Login] Failed to update inline playback setting:', error);
  }
}

export function initPreviews() {
  // Delay by 2.5 seconds to ensure it applies after YouTube's initial load
  // overrides. The setting is read again then, so a change meanwhile stands.
  // Default is applied too: a record forced earlier (another account's
  // setting, say) is given back to YouTube at startup, not only on a change.
  setTimeout(() => {
    setInlinePlayback(configRead('videoPreviews'));
  }, 2500);
}

// CSS rules live in auto-login.css and are scoped by body.ytaf-bypassing-login,
// so toggling the body class activates/deactivates the page-hide instantly with
// no <style> element churn.
function injectBypassCSS() {
    if (document.body) document.body.classList.add(BYPASS_BODY_CLASS);
}

function finalizeBypass() {
    console.info('[Auto Login] Bypass: Done. Cleaning up...');
    setTimeout(() => {
        if (document.body) document.body.classList.remove(BYPASS_BODY_CLASS);
    }, 2000);
}

// Account selection is skipped only when the master toggle is on and the user
// hasn't asked to be prompted for who is watching.
function shouldAutoSelectAccount() {
  return configRead('enableAutoLogin') && configRead('autoSelectAccount');
}

// Whether the selector is gone (a forced bypass never asks): the bypass is
// then given up, and the page shown again.
function selectorLeft(force) {
    if (force || (document.body && document.body.classList.contains(SELECTORS.ACCOUNT_SELECTOR))) return false;
    if (document.body) document.body.classList.remove(BYPASS_BODY_CLASS);
    return true;
}

/**
 * "Who's watching?" answered before it is shown: YouTube opens the selector
 * with a startAccountSelectorCommand, and the answer a pick of the same
 * account gives (onIdentityChanged, isSameIdentity) goes back in its place, so
 * the app carries on to the command's nextEndpoint with the account it has.
 * As Bolli YouTube does it (github.com/aktiwers/bolli-youtube, GPL-3.0,
 * player/tv-page.ts). Nothing is shown, hidden or pressed, so nothing depends
 * on timing; the key presses below stay for a selector that comes up all the
 * same (the hook not in yet, or YouTube opening it another way).
 */
function answerAccountSelector(resolveCommand, payload, extra) {
  const command = payload.startAccountSelectorCommand;
  // Only in the window after a start or a relaunch, and once in it, as the
  // key presses: later, opening the selector is the viewer's choice.
  if (!shouldAutoSelectAccount() || !command || typeof command !== 'object' || Date.now() > bypassUntil) {
    return resolveCommand(payload, extra);
  }
  bypassUntil = 0;
  console.info('[Auto Login] Account selector answered with the current account');
  return resolveCommand({
    onIdentityChanged: {
      identityActionContext: {
        nextEndpoint: command.nextEndpoint,
        eventTrigger: 'ACCOUNT_EVENT_TRIGGER_WHOS_WATCHING',
        reloadRequired: undefined
      },
      isSameIdentity: true
    },
    commandMetadata: { webCommandMetadata: { clientAction: true } }
  });
}

ResolveCommandRegistry.setHooks({ startAccountSelectorCommand: answerAccountSelector })
  .catch((err) => console.warn('[Auto Login] No command hook for the account selector:', err && err.message));

export function attemptActiveBypass(force = false) {
    if (!shouldAutoSelectAccount()) return;
    const isSelector = document.body && document.body.classList.contains(SELECTORS.ACCOUNT_SELECTOR);

    // Note: launch-param gating was removed deliberately — we check for the
    // account selector page on normal loads too, not just parameterised ones.
    if (!isSelector && !force) return;
    if (!force && Date.now() > bypassUntil) return;
	
    console.info('[Auto Login] Active Bypass: Selector Detected! Executing sequence...');
    bypassUntil = 0;
    injectBypassCSS();

    setTimeout(() => {
        // The option may have been turned off during the delay; stop and unhide the selector
        if (!shouldAutoSelectAccount()) {
            bypassUntil = Date.now() + BYPASS_WINDOW_MS;
            if (document.body) document.body.classList.remove(BYPASS_BODY_CLASS);
            return;
        }
        // The viewer left the selector during the delay: the keys would go
        // to whatever page is on screen now.
        if (selectorLeft(force)) return;
        if (isGuestMode()) {
            sendKey(REMOTE_KEYS.DOWN);
            setTimeout(() => {
                // ...also between the guest's Down and Enter.
                if (selectorLeft(force)) return;
                sendKey(REMOTE_KEYS.ENTER);
                finalizeBypass();
            }, 200);
        } else {
            sendKey(REMOTE_KEYS.ENTER);
            finalizeBypass();
        }
    }, 500);
}

/** A relaunch: the window opens again, from now. */
export function resetActiveBypass() {
    bypassUntil = Date.now() + BYPASS_WINDOW_MS;
    // Identity may have changed between launches (sign-in/out); drop the cached guest flag.
    invalidateGuestModeCache();
}

function setupActiveBypassListener() {
    if (pageObserverAttached) return;
    window.addEventListener('ytaf-page-update', (evt) => {
        if (evt.detail && evt.detail.isAccountSelector) {
            attemptActiveBypass();
        }
    });
    pageObserverAttached = true;
    // utils.js reports the page state it starts on before this listener is
    // in: a selector already on screen would otherwise never be reported.
    if (document.body && document.body.classList.contains(SELECTORS.ACCOUNT_SELECTOR)) attemptActiveBypass();
}

function initAutoLogin() {
  if (configRead('enableAutoLogin')) {
    console.info('[Auto Login] Initializing...');
    if (configRead('autoSelectAccount')) disableWhosWatching();
    disablePromoUpsell();
    setupActiveBypassListener();
  }
}

function initAccountSelection() {
  if (!configRead('autoSelectAccount')) setAlwaysAskWhosWatching(true);
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', () => { initAutoLogin(); initAccountSelection(); initPreviews(); })
  : (initAutoLogin(), initAccountSelection(), initPreviews());

configAddChangeListener('enableAutoLogin', ({ detail }) => {
  if (detail.newValue) {
    console.info('Auto login setting enabled');
    initAutoLogin();
  } else {
    console.info('Auto login disabled');
    // Reset local storage time value, unless "always ask" is keeping it in the past
    if (configRead('autoSelectAccount')) disableWhosWatching(false);
    disablePromoUpsell(false);
  }
});

configAddChangeListener('autoSelectAccount', ({ detail }) => {
  setAlwaysAskWhosWatching(!detail.newValue);
  // Turning auto-select back on restores the 7 day suppression if auto login is on
  if (detail.newValue && configRead('enableAutoLogin')) disableWhosWatching(true);
});

configAddChangeListener('videoPreviews', ({ detail }) => {
  setInlinePlayback(detail.newValue);
});