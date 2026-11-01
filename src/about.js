/**
 * The About tab of the settings panel, and what it shows without being opened:
 *
 * - Update check: once a day, a while after the app starts, the Homebrew
 *   Channel listing of this build's package (repo.json, or repo-webos22.json
 *   for the webOS 22+ build) is read from GitHub. A newer full release opens an
 *   "Update available" window on a browse page (never over a video), with the
 *   release notes of every version since the installed one, at most once a day
 *   per version: Update and Skip where the app can install it, else OK; the
 *   tab shows the result, and
 *   a button checks again. Pre-releases are not in the listing, so a tester on
 *   one is never told to "update" to the release before it.
 * - Release notes: the windows below read them from GitHub (CHANGELOG.md on
 *   main) when they open, not bundled: the whole file is over 100 kB.
 * - What's New: the first time the app starts after an update, a window shows
 *   the release notes of the installed version. A first install
 *   shows nothing; an update from a version before this one, which stored no
 *   seen version, counts as an update when there are settings already.
 * - Install: when a newer release is listed, its package (the listing's
 *   ipkUrl and sha256) can be handed to the Homebrew Channel's installer
 *   service, which installs a package from any address (this fork is not in
 *   the Homebrew Channel's own list), with its progress shown; the app closes
 *   when it is installed. A TV without the Homebrew Channel (an install from
 *   a computer, in Developer Mode) cannot install from the app at all: the
 *   webOS installer takes no requests from an app. There the tab says to
 *   install the update from a computer, with the release page's address.
 * - The windows take every key while they are open: Up and Down scroll the
 *   notes, Left and Right pick a button, OK presses it, Back closes.
 * - Support: the Ko-fi page and the project page, as text and as QR codes to
 *   scan with a phone, and buttons that open them in the TV's browser.
 *
 * The webOS calls (install, launch) go through PalmServiceBridge and are best
 * effort: a firmware that has no bridge or refuses the call gets a toast.
 */
import { configRead, configAddChangeListener } from './config.js';
import { showNotification } from './notifications.js';
import { VERSION_LABEL } from './version.js';
import { REMOTE_KEYS } from './utils.js';
import qrKofiUrl from './icons/qr-kofi.svg';
import qrGithubUrl from './icons/qr-github.svg';

/* global __YTAF_FLAVOR__, __YTAF_UPDATE_LISTING__ */
const FLAVOR = typeof __YTAF_FLAVOR__ === 'string' ? __YTAF_FLAVOR__ : 'legacy';
const LISTING = typeof __YTAF_UPDATE_LISTING__ === 'string' && __YTAF_UPDATE_LISTING__ ? __YTAF_UPDATE_LISTING__ : null;

const RAW = 'https://raw.githubusercontent.com/foxi69/youtube-webos/main/';
const CHANGELOG_URL = RAW + 'CHANGELOG.md';
const REPO_JSON_URL = (LISTING || RAW) + (FLAVOR === 'modern' ? 'repo-webos22.json' : 'repo.json');
export const SUPPORT_URL = 'ko-fi.com/foxi69';
export const PROJECT_URL = 'github.com/foxi69/youtube-webos';
const RELEASE_URL = 'github.com/foxi69/youtube-webos/releases/latest';
const HOMEBREW_ID = 'org.webosbrew.hbchannel';

const CHECK_EVERY_MS = 20 * 60 * 60 * 1000;
const LAUNCH_DELAY_MS = 15000;
const REQUEST_TIMEOUT_MS = 10000;
const WHATS_NEW_WAIT_MS = 60000;
// How long an update window waits for a browse page (a long video, say).
const OFFER_WAIT_MS = 3 * 60 * 60 * 1000;
const CHECK_KEY = 'ytaf-update-check';
const SEEN_KEY = 'ytaf-seen-version';

/** The installed version, without the build commit ("0.9.1"); '' in a dev build. */
export const INSTALLED = (VERSION_LABEL.match(/^\d+(?:\.\d+)*/) || [''])[0];

/** Compares dotted versions numerically: <0, 0 or >0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

const isNewer = (version) => !!version && !!INSTALLED && compareVersions(version, INSTALLED) > 0;

function get(url) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = REQUEST_TIMEOUT_MS;
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.responseText) : reject(new Error('HTTP ' + xhr.status)));
      xhr.onerror = () => reject(new Error('network'));
      xhr.ontimeout = () => reject(new Error('timeout'));
      xhr.send();
    } catch (err) {
      reject(err);
    }
  });
}

function readJSON(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key)) || null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage full or blocked: the check runs again next time */ }
}

// ---- webOS service calls ----------------------------------------------------

// A bridge collected before its answer arrives drops the answer: each call
// stays referenced until it is done (screensaver-fix.js does the same).
const liveBridges = [];

/**
 * Calls a luna service. `onResponse(res)` gets each parsed answer; the call is
 * dropped after the first one unless `keep(res)` says more are coming.
 * Returns false when there is no service bridge.
 */
function lunaCall(uri, params, onResponse, keep) {
  const Bridge = typeof window !== 'undefined' ? window.PalmServiceBridge : null;
  if (typeof Bridge !== 'function') return false;
  try {
    const bridge = new Bridge();
    liveBridges.push(bridge);
    bridge.onservicecallback = (msg) => {
      let res = null;
      try { res = JSON.parse(msg); } catch { /* not JSON */ }
      if (!keep || !keep(res)) {
        const i = liveBridges.indexOf(bridge);
        if (i !== -1) liveBridges.splice(i, 1);
      }
      if (onResponse) onResponse(res || {});
    };
    bridge.call(uri, JSON.stringify(params));
    return true;
  } catch {
    return false;
  }
}

function launchApp(id, params, failText) {
  const ok = lunaCall('luna://com.webos.applicationManager/launch', params ? { id, params } : { id }, (res) => {
    if (res.returnValue === false) showNotification(failText, 5000);
  });
  if (!ok) showNotification(failText, 5000);
}

/**
 * Whether the Homebrew Channel is installed: 'yes', 'no', or 'unknown' when
 * the TV would not say (the call refused). `cb` gets the answer once.
 */
function detectHomebrew(cb) {
  const ok = lunaCall('luna://com.webos.applicationManager/getAppInfo', { id: HOMEBREW_ID }, (res) => {
    if (res.returnValue && res.appInfo) cb('yes');
    else if (/denied|permission|not allowed/i.test(res.errorText || '')) cb('unknown');
    else cb('no');
  });
  // No bridge (webOS 25): the app cannot ask, and could not install anyway.
  if (!ok) cb('blocked');
}

const canReachInstaller = (homebrew) => homebrew === 'yes' || homebrew === 'unknown';

/** What to do where the app cannot install `latest` itself. */
function computerInstallText(latest, homebrew) {
  const fromComputer = `from a computer with webOS Dev Manager; the package is on the release page: ${RELEASE_URL}`;
  if (homebrew === 'no') return `The Homebrew Channel is not installed on this TV, so the app cannot install ${latest} itself. Install it ${fromComputer}`;
  if (homebrew === 'blocked') return `This TV does not let the app install updates. Update from the Homebrew Channel if you use it, or install ${latest} ${fromComputer}`;
  return `Without the Homebrew Channel, install ${latest} ${fromComputer}`;
}

/** Opens `url` in the TV's web browser. */
function openInBrowser(url) {
  launchApp('com.webos.app.browser', { target: url }, 'Could not open the browser on this TV. Scan the code instead.');
}


// ---- update check ---------------------------------------------------------

let updateState = { status: 'idle', latest: null };
const stateListeners = [];

function setUpdateState(state) {
  updateState = state;
  for (let i = 0; i < stateListeners.length; i++) stateListeners[i](state);
}

/** Calls `fn` with the update state now and on every change. */
export function onUpdateState(fn) {
  stateListeners.push(fn);
  fn(updateState);
}

/** Reads the newest released version; resolves to it, or null on failure. */
export function checkForUpdates() {
  setUpdateState({ status: 'checking', latest: updateState.latest });
  return get(REPO_JSON_URL)
    .then((text) => {
      const data = JSON.parse(text);
      const pkg = data && data.packages && data.packages[0];
      const manifest = (pkg && pkg.manifest) || {};
      const latest = manifest.version;
      if (typeof latest !== 'string' || !/^\d+(?:\.\d+)*$/.test(latest)) throw new Error('no version');
      const ipk = typeof manifest.ipkUrl === 'string' && /^https:\/\//.test(manifest.ipkUrl)
        ? { url: manifest.ipkUrl, sha256: manifest.ipkHash && manifest.ipkHash.sha256 }
        : null;
      const stored = readJSON(CHECK_KEY) || {};
      stored.at = Date.now();
      stored.latest = latest;
      stored.ipk = ipk;
      writeJSON(CHECK_KEY, stored);
      setUpdateState({ status: 'done', latest, ipk });
      return latest;
    })
    .catch(() => {
      setUpdateState({ status: 'error', latest: updateState.latest });
      return null;
    });
}

/**
 * The "Update available" window for a newer release: at most once a day for
 * the same version, and only on a browse page.
 */
function offerUpdate(latest) {
  if (!isNewer(latest)) return;
  const stored = readJSON(CHECK_KEY) || {};
  if (stored.notified === latest && Date.now() - (stored.notifiedAt || 0) < CHECK_EVERY_MS) return;
  whenIdle(OFFER_WAIT_MS, () => {
    detectHomebrew((homebrew) => {
      const now = readJSON(CHECK_KEY) || {};
      now.notified = latest;
      now.notifiedAt = Date.now();
      writeJSON(CHECK_KEY, now);
      openUpdateDialog(latest, now.ipk || updateState.ipk || null, homebrew);
    });
  });
}

function launchCheck() {
  if (!configRead('checkForUpdates')) {
    setUpdateState({ status: 'off', latest: null });
    return;
  }
  const stored = readJSON(CHECK_KEY);
  if (stored && stored.latest && Date.now() - (stored.at || 0) < CHECK_EVERY_MS) {
    setUpdateState({ status: 'done', latest: stored.latest, ipk: stored.ipk || null });
    offerUpdate(stored.latest);
    return;
  }
  checkForUpdates().then(offerUpdate);
}

function describeUpdateState(state) {
  switch (state.status) {
    case 'off': return 'Update check is off.';
    case 'checking': return 'Checking for updates...';
    case 'error': return 'Could not check for updates (no connection to GitHub).';
    case 'done':
      if (isNewer(state.latest)) return `Version ${state.latest} is available.`;
      return `Up to date (latest release: ${state.latest}).`;
    default: return '';
  }
}

// ---- install --------------------------------------------------------------

/**
 * Hands the new package to the Homebrew Channel's installer service, which
 * downloads it, checks its hash and installs it over this app (which then
 * closes). `report(text, failed)` gets its progress.
 */
function installUpdate(ipk, report) {
  if (!ipk || !ipk.url) {
    report('No package to install in the listing.', true);
    return;
  }
  report('Starting the download...', false);
  const params = { ipkUrl: ipk.url, subscribe: true };
  if (ipk.sha256) params.ipkHash = ipk.sha256;
  const done = (res) => res.returnValue === false || res.finished === true;
  const ok = lunaCall('luna://org.webosbrew.hbchannel.service/install', params, (res) => {
    if (res.returnValue === false) {
      report(`Could not install: ${res.errorText || 'the Homebrew Channel refused the request'}. Install it from a computer instead (below).`, true);
    } else if (res.finished) {
      report('Installed. The app closes now; start it again.', false);
    } else if (res.statusText || typeof res.progress === 'number') {
      report((res.statusText || 'Installing') + (typeof res.progress === 'number' ? ` ${Math.round(res.progress)}%` : ''), false);
    }
  }, (res) => !done(res));
  if (!ok) report('This TV does not let the app reach the Homebrew Channel installer. Install it from a computer instead (below).', true);
}

// ---- changelog ------------------------------------------------------------

/**
 * CHANGELOG.md as [{ version, date, blocks: [{ type: 'h' | 'li' | 'p', text }] }],
 * newest first, as the file has them.
 */
export function parseChangelog(md) {
  const out = [];
  let entry = null;
  const lines = String(md).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = line.match(/^##\s+\[([^\]]+)\](.*)$/);
    if (head) {
      entry = { version: head[1].trim(), date: head[2].replace(/^[\s-]+/, '').trim(), blocks: [] };
      out.push(entry);
      continue;
    }
    if (!entry) continue;
    const blocks = entry.blocks;
    const last = blocks[blocks.length - 1];
    if (/^#{2,6}\s+/.test(line)) {
      blocks.push({ type: 'h', text: line.replace(/^#+\s+/, '') });
    } else if (/^\s*[+*-]\s+/.test(line)) {
      blocks.push({ type: 'li', text: line.replace(/^\s*[+*-]\s+/, '') });
    } else if (!line.trim()) {
      if (last && last.type !== 'gap') blocks.push({ type: 'gap' });
    } else if (last && (last.type === 'p' || (last.type === 'li' && /^\s/.test(line)))) {
      last.text += ' ' + line.trim();
    } else {
      blocks.push({ type: 'p', text: line.trim() });
    }
  }
  return out;
}

/** Markdown's inline bits as nodes: **bold**, `code`, [text](link) as its text. */
function appendInline(el, text) {
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g;
  let at = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > at) el.appendChild(document.createTextNode(text.slice(at, m.index)));
    if (m[1] !== undefined) {
      const b = document.createElement('b');
      b.textContent = m[1];
      el.appendChild(b);
    } else if (m[2] !== undefined) {
      const code = document.createElement('code');
      code.textContent = m[2];
      el.appendChild(code);
    } else {
      el.appendChild(document.createTextNode(m[3]));
    }
    at = re.lastIndex;
  }
  if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
}

function renderEntry(entry) {
  const box = document.createElement('div');
  box.className = 'ytaf-cl-entry';
  const head = document.createElement('div');
  head.className = 'ytaf-cl-version';
  head.textContent = entry.version;
  const date = document.createElement('span');
  date.className = 'ytaf-cl-date';
  date.textContent = entry.date ? '  ' + entry.date : '';
  head.appendChild(date);
  if (INSTALLED && entry.version === INSTALLED) {
    box.classList.add('ytaf-cl-installed');
    head.appendChild(Object.assign(document.createElement('span'), { className: 'ytaf-cl-tag', textContent: 'installed' }));
  } else if (isNewer(entry.version)) {
    head.appendChild(Object.assign(document.createElement('span'), { className: 'ytaf-cl-tag', textContent: 'newer' }));
  }
  box.appendChild(head);
  for (let i = 0; i < entry.blocks.length; i++) {
    const block = entry.blocks[i];
    if (block.type === 'gap') continue;
    const el = document.createElement('div');
    el.className = block.type === 'h' ? 'ytaf-cl-heading' : block.type === 'li' ? 'ytaf-cl-item' : 'ytaf-cl-text';
    appendInline(el, block.text);
    box.appendChild(el);
  }
  return box;
}

let changelogRequest = null;

function loadChangelog() {
  if (!changelogRequest) {
    changelogRequest = get(CHANGELOG_URL).then((md) => {
      const entries = parseChangelog(md);
      // Anything but the changelog (a captive portal's page, an error page).
      if (!entries.length) throw new Error('no versions');
      return entries;
    });
    // A failed load is tried again the next time, not remembered.
    changelogRequest.catch(() => { changelogRequest = null; });
  }
  return changelogRequest;
}

// ---- windows (Update available, What's New) -------------------------------

let dialog = null;
const pendingDialogs = [];
// The key that closed a window: its keyup must not reach YouTube either.
let swallowKeyUp = null;
const CLOSE_CODES = [REMOTE_KEYS.BACK.code, 27, 8];

function stopKey(evt) {
  evt.preventDefault();
  evt.stopPropagation();
  if (evt.stopImmediatePropagation) evt.stopImmediatePropagation();
}

function focusButton(index) {
  const buttons = dialog.buttons.filter((b) => b.style.display !== 'none');
  if (!buttons.length) return;
  dialog.focus = (index + buttons.length) % buttons.length;
  for (let i = 0; i < dialog.buttons.length; i++) dialog.buttons[i].classList.remove('ytaf-dialog-focused');
  buttons[dialog.focus].classList.add('ytaf-dialog-focused');
}

function onDialogKey(evt) {
  if (!dialog) {
    if (swallowKeyUp !== null && evt.type === 'keyup' && evt.keyCode === swallowKeyUp) {
      swallowKeyUp = null;
      stopKey(evt);
    }
    return;
  }
  stopKey(evt);
  if (evt.type !== 'keydown') return;
  const code = evt.keyCode;
  const reader = dialog.reader;
  if (code === REMOTE_KEYS.UP.code || code === REMOTE_KEYS.DOWN.code) {
    const step = Math.max(40, Math.round(reader.clientHeight * 0.7));
    reader.scrollTop += code === REMOTE_KEYS.DOWN.code ? step : -step;
  } else if (code === REMOTE_KEYS.LEFT.code || code === REMOTE_KEYS.RIGHT.code) {
    focusButton(dialog.focus + (code === REMOTE_KEYS.RIGHT.code ? 1 : -1));
  } else if (code === REMOTE_KEYS.ENTER.code) {
    const buttons = dialog.buttons.filter((b) => b.style.display !== 'none');
    swallowKeyUp = code;
    if (buttons[dialog.focus]) buttons[dialog.focus].click();
  } else if (CLOSE_CODES.indexOf(code) !== -1) {
    swallowKeyUp = code;
    closeDialog();
  }
}

// Registered when this module loads, before ui.js's own window handlers, so
// an open window gets the keys first (the green key, the shortcuts) and
// YouTube none of them.
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onDialogKey, true);
  window.addEventListener('keyup', onDialogKey, true);
  window.addEventListener('keypress', onDialogKey, true);
}

function closeDialog() {
  if (!dialog) return;
  const root = dialog.root;
  dialog = null;
  if (root.parentNode) root.parentNode.removeChild(root);
  const next = pendingDialogs.shift();
  if (next) setTimeout(next, 500);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Opens a window: a title, a subtitle, release notes (a promise of changelog
 * entries) in a box Up and Down scroll, an optional `extra` node, and buttons
 * ([{ text, action, keep }]; a button closes the window unless `keep`).
 * Returns { setStatus(text) }.
 */
function openDialog({ title, subtitle, notes, extra, buttons, emptyText }) {
  const root = el('div', 'ytaf-dialog-backdrop');
  const box = el('div', 'ytaf-dialog theme-' + (configRead('uiTheme') || 'default'));
  root.appendChild(box);
  box.appendChild(el('div', 'ytaf-dialog-title', title));
  if (subtitle) box.appendChild(el('div', 'ytaf-dialog-subtitle', subtitle));
  const reader = el('div', 'ytaf-reader ytaf-dialog-reader', 'Loading the release notes...');
  box.appendChild(reader);
  const status = el('div', 'ytaf-dialog-status');
  status.style.display = 'none';
  box.appendChild(status);
  if (extra) box.appendChild(extra);
  const row = el('div', 'ytaf-dialog-buttons');
  const made = buttons.map((spec) => {
    const b = el('button', 'ytaf-dialog-btn', spec.text);
    b.tabIndex = -1;
    b.addEventListener('click', () => {
      if (spec.action) spec.action();
      if (!spec.keep) closeDialog();
    });
    row.appendChild(b);
    return b;
  });
  box.appendChild(row);
  dialog = { root, reader, buttons: made, focus: 0 };
  document.body.appendChild(root);
  focusButton(0);

  notes.then((entries) => {
    reader.textContent = '';
    if (!entries.length) reader.textContent = emptyText;
    for (let i = 0; i < entries.length; i++) reader.appendChild(renderEntry(entries[i]));
  }, () => {
    reader.textContent = 'The release notes could not be loaded (no connection to GitHub).';
  });

  return {
    setStatus(text) {
      status.textContent = text;
      status.style.display = text ? 'block' : 'none';
    }
  };
}

/** Runs `fn` once the app is on a browse page with no window or panel open. */
function whenIdle(maxWaitMs, fn) {
  const start = Date.now();
  const tick = () => {
    if (Date.now() - start > maxWaitMs) return;
    const panel = document.querySelector('.ytaf-ui-container');
    const panelOpen = panel && panel.style.display !== 'none';
    const browsing = document.body && document.body.classList.contains('WEB_PAGE_TYPE_BROWSE');
    if (!browsing || panelOpen) {
      setTimeout(tick, 2000);
      return;
    }
    if (dialog) {
      pendingDialogs.push(tick);
      return;
    }
    fn();
  };
  tick();
}

/** The computer-install note with the release page's address, for a TV without the Homebrew Channel. */
function computerNote(latest, homebrew) {
  return el('div', 'ytaf-dialog-note', computerInstallText(latest, homebrew));
}

function openUpdateDialog(latest, ipk, homebrew) {
  const canInstall = !!ipk && canReachInstaller(homebrew);
  // Shown where the app cannot install, and where an install fails.
  const note = computerNote(latest, homebrew);
  if (homebrew === 'yes' && ipk) note.style.display = 'none';
  let installing = false;
  let win = null;
  // Update and Skip (until tomorrow's check) where the app can install it;
  // OK alone where it cannot.
  const buttons = [];
  if (canInstall) {
    buttons.push({
      text: 'Update',
      keep: true,
      action: () => {
        if (installing) return;
        installing = true;
        installUpdate(ipk, (text, failed) => {
          win.setStatus(text);
          if (failed) {
            installing = false;
            note.style.display = 'block';
          }
        });
      }
    });
  }
  buttons.push({ text: canInstall ? 'Skip' : 'OK' });
  win = openDialog({
    title: 'Update available',
    subtitle: `Version ${latest}  \u00b7  Current ${INSTALLED}`,
    notes: loadChangelog().then((entries) => entries.filter((e) => isNewer(e.version) && compareVersions(e.version, latest) <= 0)),
    emptyText: `No release notes for ${latest} yet.`,
    extra: note,
    buttons
  });
}

// ---- the tab --------------------------------------------------------------

/**
 * Fills the About page. `h` is ui.js's createElement, `checkbox` its
 * createConfigCheckbox and `section` its createSection.
 */
export function buildAboutPage(page, h, checkbox, section) {
  const status = h('div', { class: 'ytaf-about-line' });
  const installStatus = h('div', { class: 'ytaf-about-line', style: { display: 'none' } });
  let installing = false;
  let homebrew = 'unknown';
  let installFailed = false;
  const report = (text, failed) => {
    installStatus.textContent = text;
    installStatus.style.display = 'block';
    if (failed) {
      installing = false;
      installFailed = true;
      render(updateState);
    }
  };
  const installButton = h('button', {
    class: 'ytaf-list-btn ytaf-list-action',
    tabIndex: 0,
    style: { display: 'none' },
    events: {
      click: () => {
        if (installing) return;
        installing = true;
        installUpdate(updateState.ipk, report);
      }
    }
  });
  // Without the Homebrew Channel: install from a computer (the TV's browser
  // cannot install a package).
  const computerNote = h('div', { class: 'ytaf-about-line', style: { display: 'none' } });
  const render = (state) => {
    status.textContent = describeUpdateState(state);
    const newer = state.status === 'done' && isNewer(state.latest);
    installButton.textContent = `Download and Install ${state.latest || ''}`.trim();
    installButton.style.display = newer && state.ipk && canReachInstaller(homebrew) ? 'block' : 'none';
    computerNote.textContent = computerInstallText(state.latest, homebrew);
    computerNote.style.display = newer && (homebrew !== 'yes' || installFailed || !state.ipk) ? 'block' : 'none';
  };
  onUpdateState(render);
  detectHomebrew((answer) => {
    homebrew = answer;
    render(updateState);
  });

  page.appendChild(section('Version', [
    h('div', { class: 'ytaf-about-line ytaf-about-version', text: 'YouTube Foxtended ' + VERSION_LABEL }),
    status,
    installButton,
    installStatus,
    computerNote,
    h('button', {
      class: 'ytaf-list-btn ytaf-list-action',
      text: 'Check for Updates Now',
      tabIndex: 0,
      events: { click: () => { checkForUpdates(); } }
    }),
    checkbox('checkForUpdates'),
    checkbox('showWhatsNew')
  ]));

  // Without the service bridge (webOS 25) the app cannot start the browser.
  const canOpenBrowser = typeof window.PalmServiceBridge === 'function';
  const qr = (src, title, url) => {
    const box = h('div', { class: 'ytaf-about-qr' },
      h('img', { src, alt: url }),
      h('div', { class: 'ytaf-about-qr-title', text: title }),
      h('div', { class: 'ytaf-about-qr-url', text: url }));
    if (canOpenBrowser) {
      box.appendChild(h('button', {
        class: 'ytaf-list-btn',
        text: 'Open in Browser',
        tabIndex: 0,
        events: { click: () => openInBrowser('https://' + url) }
      }));
    }
    return box;
  };
  page.appendChild(section('Support', [
    h('div', { class: 'ytaf-about-line ytaf-about-center', text: `The app is and stays free. If you would like to support it, scan a code with your phone${canOpenBrowser ? ' or open it in the TV\'s browser' : ''}.` }),
    h('div', { class: 'ytaf-about-qrs' },
      qr(qrKofiUrl, 'Support on Ko-fi', SUPPORT_URL),
      qr(qrGithubUrl, 'Project, changelog and issues', PROJECT_URL))
  ]));

}

// ---- What's New -----------------------------------------------------------

/**
 * On the first start after an update, opens the panel on the About tab with
 * the changelog at the installed version, once the app is on a browse page
 * (not the account picker, a video or a Short).
 */
function whatsNewAfterUpdate() {
  if (!INSTALLED) return;
  let seen;
  let existingUser;
  try {
    seen = window.localStorage.getItem(SEEN_KEY);
    // Versions before this one stored no seen version: settings of their own
    // mean an update from one of them, not a first install.
    existingUser = !!window.localStorage.getItem('ytaf-configuration');
    window.localStorage.setItem(SEEN_KEY, INSTALLED);
  } catch { return; }
  const updated = seen ? compareVersions(INSTALLED, seen) > 0 : existingUser;
  if (!updated || !configRead('showWhatsNew')) return;
  // The installed version's notes only.
  const since = (e) => e.version === INSTALLED;
  setTimeout(() => whenIdle(WHATS_NEW_WAIT_MS, () => openDialog({
    title: `What's new in ${INSTALLED}`,
    subtitle: seen ? `Updated from ${seen}` : '',
    notes: loadChangelog().then((entries) => entries.filter(since)),
    emptyText: `No release notes for ${INSTALLED}.`,
    buttons: [{ text: 'OK' }]
  })), 3000);
}

export function initAbout() {
  setTimeout(launchCheck, LAUNCH_DELAY_MS);
  configAddChangeListener('checkForUpdates', (evt) => {
    if (evt.detail.newValue) checkForUpdates();
    else setUpdateState({ status: 'off', latest: null });
  });
  whatsNewAfterUpdate();
}
