/**
 * The settings panel driven with the remote's arrows, OK and Back, as on a TV:
 * moving along the tabs (and round at either end), into a page and through its
 * rows in order and back, round from the last row to the tabs, the two-column
 * Filters section, the choice rows (Left/Right step the value), OK on a
 * checkbox and on a choice row, the text box handing Left/Right on at its
 * ends, the logo, the focus trap, and Back. Until this test nothing ran the
 * panel's own key handling (moveFocus, nearestInDirection, focusInView).
 *
 *   node bench/panel-nav-test.cjs <bundle> [legacy|modern]
 *
 * jsdom lays nothing out, and the moves are made by where things are on
 * screen, so the test lays the panel out itself (layoutRect below): the tabs in
 * a line along the top, then the open page's rows one under another, two to a
 * line in a two-column section, the text box and its Add button side by side.
 * The page scrolls: its rows move up by its scrollTop.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, trustedKey, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();

const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27, GREEN: 404 };

const { t, run } = createReporter();

// ---- The layout ----
// The panel, the tabs along its top, the open page under them. A page is
// shorter than its rows, so the long ones scroll.
const PANEL = { left: 0, top: 0, width: 1200, height: 900 };
const TAB = { left: 100, top: 100, width: 140, height: 40, pitch: 150 };
const PAGE = { left: 80, top: 200, width: 1040, height: 400 };
const ROW = 50;          // one line of rows
const ROW_H = 40;

const hasClass = (el, c) => !!(el && el.classList && el.classList.contains(c));
const rect = (left, top, width, height) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
const ZERO = rect(0, 0, 0, 0);
// What takes a box of its own in a page: a checkbox's label row, a choice row, a button, a text box.
const isUnit = (el) => el.tagName === 'LABEL' || el.tagName === 'BUTTON' || el.tagName === 'INPUT' ||
  hasClass(el, 'shortcut-control-row');

function shown(el) {
  if (!el.isConnected) return false;
  for (let n = el; n; n = n.parentElement) if (n.style && n.style.display === 'none') return false;
  return true;
}
function pageOf(el) {
  for (let n = el; n; n = n.parentElement) if (hasClass(n, 'ytaf-settings-page')) return n;
  return null;
}
// The outermost unit `el` is in (a checkbox's is its label).
function unitOf(el, page) {
  let unit = null;
  for (let n = el; n && n !== page; n = n.parentElement) if (isUnit(n)) unit = n;
  return unit;
}
// Each shown unit of `page` with its line and column.
function layoutPage(page) {
  const map = new Map();
  const perParent = new Map();
  let line = -1;
  const all = page.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!isUnit(el) || unitOf(el, page) !== el || !shown(el)) continue;
    const parent = el.parentElement;
    const k = perParent.get(parent) || 0;
    perParent.set(parent, k + 1);
    if (hasClass(parent, 'ytaf-section-2col')) {
      if (k % 2 === 0) line++;
      map.set(el, { line, box: [100 + (k % 2) * 500, 480] });
    } else if (hasClass(parent, 'ytaf-list-input-row')) {
      if (k === 0) line++;
      map.set(el, { line, box: k === 0 ? [100, 700] : [820 + (k - 1) * 200, 180] });
    } else {
      line++;
      map.set(el, { line, box: [100, 1000] });
    }
  }
  map.lines = line + 1;
  return map;
}

const scrollTops = new WeakMap();
const contentHeight = (page) => Math.max(PAGE.height, layoutPage(page).lines * ROW);
const maxScroll = (page) => contentHeight(page) - PAGE.height;

function layoutRect(el) {
  if (!shown(el)) return ZERO;
  if (hasClass(el, 'ytaf-ui-container')) return rect(PANEL.left, PANEL.top, PANEL.width, PANEL.height);
  if (hasClass(el, 'ytaf-tab-btn')) {
    const i = Array.prototype.indexOf.call(el.parentElement.children, el);
    return rect(TAB.left + i * TAB.pitch, TAB.top, TAB.width, TAB.height);
  }
  if (hasClass(el, 'ytaf-settings-page')) return rect(PAGE.left, PAGE.top, PAGE.width, PAGE.height);
  const page = pageOf(el);
  if (!page) return ZERO;
  const unit = unitOf(el, page);
  const at = unit && layoutPage(page).get(unit);
  if (!at) return ZERO;
  const top = PAGE.top + at.line * ROW - (scrollTops.get(page) || 0);
  const row = rect(at.box[0], top, at.box[1], ROW_H);
  // A checkbox is a small box at the left of its label row.
  if (el !== unit && el.tagName === 'INPUT') return rect(row.left + 10, row.top + 5, 30, 30);
  return row;
}

function installLayout(win) {
  const E = win.Element.prototype;
  E.getBoundingClientRect = function () { return layoutRect(this); };
  E.getClientRects = function () { const r = layoutRect(this); return r.width || r.height ? [r] : []; };
  const top = Object.getOwnPropertyDescriptor(E, 'scrollTop');
  const height = Object.getOwnPropertyDescriptor(E, 'scrollHeight');
  Object.defineProperty(E, 'scrollTop', {
    configurable: true,
    get() { return hasClass(this, 'ytaf-settings-page') ? scrollTops.get(this) || 0 : top.get.call(this); },
    set(v) {
      if (hasClass(this, 'ytaf-settings-page')) scrollTops.set(this, Math.max(0, Math.min(maxScroll(this), v)));
      else top.set.call(this, v);
    }
  });
  Object.defineProperty(E, 'scrollHeight', {
    configurable: true,
    get() { return hasClass(this, 'ytaf-settings-page') ? contentHeight(this) : height.get.call(this); }
  });
}

// ---- The bundle ----
function boot() {
  const { win, doc, errors, frames } = bootPage({
    code,
    inner: '<button id="outside">YouTube</button>',
    // The idle build chain runs only when the test lets it (pump).
    raf: 'manual',
    config: {
      enableAdBlock: true, enableSponsorBlock: true, enableReturnYouTubeDislike: true,
      upgradeThumbnails: false, enableAutoLogin: false, enableDeArrow: false,
      checkForUpdates: false, showWhatsNew: false
    },
    // Set before the environment, which takes it away again on the legacy build.
    setup(win) { win.fetch = () => new Promise(() => {}); },
    beforeEval: installLayout
  });
  const pump = () => { for (let i = 0; i < 20; i++) frames.pump(); };
  return { win, d: doc, errors, pump };
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;
  const { win, d, errors, pump } = boot();
  await wait(50);

  const panel = () => d.querySelector('.ytaf-ui-container');
  const tabs = () => Array.prototype.slice.call(d.querySelectorAll('.ytaf-tab-btn'));
  const page = (id) => d.getElementById('ytaf-page-' + id);
  const focused = () => d.activeElement;
  const isOpen = () => !!panel() && panel().style.display === 'block';
  // A press of the remote: keydown and keyup on whatever has the focus.
  let presses = 0;
  const lost = [];
  const press = (keyCode) => {
    for (const type of ['keydown', 'keyup']) {
      trustedKey(win, keyCode, focused() || d.body, type);
    }
    if (isOpen()) {
      presses++;
      if (!panel().contains(focused())) lost.push(keyCode + ' -> ' + (focused() && focused().tagName));
    }
  };
  // The controls a page offers the remote, in order (PANEL_FOCUSABLES in src/ui.js).
  const controlsOf = (p) => Array.prototype.slice.call(
    p.querySelectorAll('input:not([disabled]), .shortcut-control-row, button:not([disabled])'))
    .filter((el) => el.tabIndex !== -1);
  const describe = (el) => {
    if (!el) return 'nothing';
    const row = el.closest('label, .shortcut-control-row') || el;
    return el.tagName + ' "' + row.textContent.trim().slice(0, 40) + '"';
  };
  // In full view with half a row to spare above and below (focusInView), or,
  // for the first and the last row, with the page at its top or its end.
  const inView = (el, rows) => {
    const r = layoutRect(el.tagName === 'INPUT' ? (el.closest('label, .shortcut-control-row') || el) : el);
    const p = pageOf(el);
    if (el === rows[0]) return p.scrollTop === 0 && r.top >= PAGE.top;
    if (el === rows[rows.length - 1]) return p.scrollTop === maxScroll(p) && r.bottom <= PAGE.top + PAGE.height;
    return r.top - ROW_H / 2 >= PAGE.top && r.bottom + ROW_H / 2 <= PAGE.top + PAGE.height;
  };
  const value = (row) => row.querySelector('.current-value').textContent;
  const stored = async (key) => { await wait(250); return JSON.parse(win.localStorage.getItem('ytaf-configuration'))[key]; };
  const rowNamed = (p, text) => Array.prototype.slice.call(p.querySelectorAll('.shortcut-control-row'))
    .find((r) => r.querySelector('.shortcut-label').textContent.trim() === text);
  const checkboxNamed = (p, text) => {
    const label = Array.prototype.slice.call(p.querySelectorAll('label'))
      .find((l) => l.textContent.trim() === text);
    return label && label.querySelector('input');
  };

  // ---- Opening, and the tabs before the idle build has run ----
  press(KEY.GREEN);
  const openedAt = Date.now();
  t(n('green opens the panel with the focus on the Filters tab'), isOpen() && focused() === tabs()[0],
    describe(focused()));

  press(KEY.RIGHT);
  t(n('Right on a tab moves to the next tab and opens it'),
    focused() === tabs()[1] && hasClass(tabs()[1], 'active') && page('player').style.display === 'block' &&
    page('filters').style.display === 'none', describe(focused()));
  press(KEY.RIGHT);
  press(KEY.RIGHT);
  const sponsor = page('sponsor');
  t(n('Right onto a tab whose page is not built yet builds and opens it'),
    focused() === tabs()[3] && !!sponsor && sponsor.style.display === 'block', describe(focused()));
  press(KEY.DOWN);
  t(n('Down from that tab goes into its page, to its first row'),
    !!sponsor && focused() === controlsOf(sponsor)[0] && sponsor.contains(focused()), describe(focused()));
  press(KEY.UP);
  t(n('...and Up from there back to the tab'), focused() === tabs()[3], describe(focused()));

  press(KEY.RIGHT); press(KEY.RIGHT); press(KEY.RIGHT);
  t(n('About is the last tab'), focused() === tabs()[6], describe(focused()));
  press(KEY.RIGHT);
  t(n('Right on the last tab goes round to the first'),
    focused() === tabs()[0] && page('filters').style.display === 'block', describe(focused()));
  press(KEY.LEFT);
  t(n('Left on the first tab goes round to the last'),
    focused() === tabs()[6] && page('about').style.display === 'block', describe(focused()));
  for (let i = 0; i < 5; i++) press(KEY.LEFT);
  t(n('Left along the tabs back to Player'), focused() === tabs()[1] && hasClass(tabs()[1], 'active'),
    describe(focused()));

  pump();   // the idle chain: the other pages and the Filters page's feed section

  // ---- Down through a page and back up ----
  const player = page('player');
  const rows = controlsOf(player);
  // Greyed out while Auto-Translate Subtitles is Off (the default).
  const greyed = checkboxNamed(player, 'Turn On Translated Subtitles Automatically');
  const walk = (keyCode) => {
    const seen = [];
    let outOfView = '';
    for (let i = 0; i < 40; i++) {
      press(keyCode);
      if (!player.contains(focused())) break;
      seen.push(focused());
      if (!inView(focused(), rows) && !outOfView) outOfView = describe(focused()) + ' scrollTop=' + player.scrollTop;
    }
    return { seen, outOfView };
  };

  const down = walk(KEY.DOWN);
  t(n('Down walks the Player rows in order, one at a time'),
    down.seen.length === rows.length && down.seen.every((el, i) => el === rows[i]),
    down.seen.length + ' of ' + rows.length + ', first wrong: ' + describe(down.seen.find((el, i) => el !== rows[i])));
  t(n('Down passes over a greyed-out row'), !!greyed && greyed.tabIndex === -1 && down.seen.indexOf(greyed) === -1,
    greyed ? 'tabIndex ' + greyed.tabIndex : 'no greyed-out row found');
  t(n('every row Down lands on is in full view, with half a row around it'), !down.outOfView, down.outOfView);
  t(n('the page is long enough to scroll'), maxScroll(player) > 0, String(maxScroll(player)));
  t(n('Down on the last row goes back to the open tab'), focused() === tabs()[1], describe(focused()));
  t(n('...leaving the page scrolled to its end'), player.scrollTop === maxScroll(player), String(player.scrollTop));
  press(KEY.DOWN);
  t(n('Down from the tab lands on the first row although the page is scrolled'),
    focused() === rows[0] && player.scrollTop === 0, describe(focused()) + ' scrollTop=' + player.scrollTop);
  press(KEY.UP);
  t(n('Up from the first row goes to the open tab, not the tab above it'),
    focused() === tabs()[1], describe(focused()));
  press(KEY.UP);
  t(n('Up on the tab goes round to the last row, the page scrolled to its end'),
    focused() === rows[rows.length - 1] && player.scrollTop === maxScroll(player),
    describe(focused()) + ' scrollTop=' + player.scrollTop);
  const up = walk(KEY.UP);
  const back = rows.slice(0, -1).reverse();
  t(n('Up walks the rows back in order, each in full view'),
    up.seen.length === back.length && up.seen.every((el, i) => el === back[i]) && !up.outOfView,
    up.seen.length + ' of ' + back.length + ' ' + up.outOfView);
  t(n('...and from the first row to the tab'), focused() === tabs()[1] && player.scrollTop === 0,
    describe(focused()) + ' scrollTop=' + player.scrollTop);

  // ---- A choice row and a checkbox ----
  const codec = rowNamed(player, 'Force Video Codec');
  let steps = 0;
  while (focused() !== codec && steps++ < 20) press(KEY.DOWN);
  t(n('Down reaches the Force Video Codec row'), !!codec && focused() === codec, describe(focused()));
  const was = codec && value(codec);
  press(KEY.RIGHT);
  t(n('Right on a choice row picks the next choice, the focus stays'),
    was === 'Auto' && value(codec) === 'AV1' && focused() === codec && hasClass(tabs()[1], 'active'),
    was + ' -> ' + value(codec) + ', focus ' + describe(focused()));
  press(KEY.LEFT);
  press(KEY.LEFT);
  t(n('Left from the first choice goes round to the last'), value(codec) === 'Avoid AV1' && focused() === codec,
    value(codec));
  press(KEY.OK);
  t(n('OK on a choice row steps it on once'), value(codec) === 'Auto', value(codec));
  press(KEY.OK);
  t(n('...and the choice is saved'), await stored('forceVideoCodec') === 'av1' && value(codec) === 'AV1',
    value(codec));

  steps = 0;
  while (focused() !== rows[0] && steps++ < 20) press(KEY.UP);
  const maxQuality = rows[0];
  t(n('the first Player row is the Force Max Quality checkbox'),
    maxQuality === checkboxNamed(player, 'Force Max Quality') && focused() === maxQuality, describe(focused()));
  press(KEY.OK);
  t(n('OK ticks a checkbox and saves it'), maxQuality.checked === true && await stored('forceHighResVideo') === true &&
    focused() === maxQuality, 'checked=' + maxQuality.checked);
  press(KEY.OK);
  t(n('OK again unticks it'), maxQuality.checked === false && await stored('forceHighResVideo') === false,
    'checked=' + maxQuality.checked);

  // ---- The two-column Filters section ----
  press(KEY.UP);
  press(KEY.LEFT);
  const filters = page('filters');
  t(n('Up, then Left, to the Filters tab'), focused() === tabs()[0] && filters.style.display === 'block',
    describe(focused()));
  const cb = (text) => checkboxNamed(filters, text);
  press(KEY.DOWN);
  t(n('Down into Filters lands on Ad Blocking'), focused() === cb('Ad Blocking'), describe(focused()));
  press(KEY.RIGHT);
  const right = cb('Reduce Telemetry & Tracking');
  t(n('Right in a two-column section moves to the other half of the line'), focused() === right,
    describe(focused()));
  press(KEY.RIGHT);
  t(n('Right at the end of a line stays put'), focused() === right, describe(focused()));
  const twoCol = Array.prototype.slice.call(filters.querySelectorAll('.ytaf-section-2col > label input'));
  press(KEY.DOWN);
  t(n('Down keeps to the column'), focused() === twoCol[3], describe(focused()) + ' wanted ' + describe(twoCol[3]));
  press(KEY.LEFT);
  t(n('Left to the other column'), focused() === twoCol[2], describe(focused()));
  press(KEY.UP);
  t(n('Up to the line above'), focused() === twoCol[0], describe(focused()));

  // ---- The text box hands Left and Right on at its ends ----
  const box = filters.querySelector('.ytaf-text-input[placeholder="A word or phrase, then OK"]');
  const add = box && box.parentElement.querySelector('button');
  t(n('the feed section with its text boxes is built'), !!box && !!add);
  if (box && add) {
    box.focus();
    box.value = 'abc';
    box.setSelectionRange(1, 1);
    press(KEY.RIGHT);
    t(n('Right inside typed text stays in the text box'), focused() === box, describe(focused()));
    box.setSelectionRange(3, 3);
    press(KEY.RIGHT);
    t(n('Right at the end of the text moves on to the Add button'), focused() === add, describe(focused()));
    press(KEY.LEFT);
    t(n('Left from Add goes back to the text box'), focused() === box, describe(focused()));
    box.value = '';
  }

  // ---- A tab picked with the pointer from inside a page ----
  tabs()[4].click();
  const shortcuts = page('shortcuts');
  const key0 = shortcuts.querySelector('.shortcut-control-row');
  t(n('picking a tab with the pointer from a page focuses the first row of the new page'),
    focused() === key0 && shortcuts.style.display === 'block', describe(focused()));
  const action = value(key0);
  press(KEY.RIGHT);
  const next = value(key0);
  press(KEY.LEFT);
  t(n('Left and Right on a Shortcuts row change its action, not the tab'),
    next !== action && value(key0) === action && focused() === key0 && hasClass(tabs()[4], 'active'),
    action + ' -> ' + next + ' -> ' + value(key0));

  // ---- The logo switches the theme ----
  const themeRow = rowNamed(page('interface'), 'UI Theme');
  const names = ['Fox', 'Blue', 'Red'];
  const theme = themeRow && value(themeRow);
  const logo = Array.prototype.slice.call(panel().querySelectorAll('.ytaf-logo')).find((l) => l.style.display !== 'none');
  if (logo) logo.click();
  t(n('the logo switches to the next theme'), !!logo && names.indexOf(theme) !== -1 &&
    value(themeRow) === names[(names.indexOf(theme) + 1) % names.length], theme + ' -> ' + (themeRow && value(themeRow)));
  t(n('...and puts the focus on the open tab'), focused() === tabs()[4], describe(focused()));

  // ---- The focus stays in the panel ----
  d.getElementById('outside').focus();
  t(n('focus taken outside the panel comes back to it'), focused() === tabs()[4], describe(focused()));
  t(n('no key press left the focus outside the panel'), lost.length === 0 && presses > 50,
    presses + ' presses; ' + lost.join(', '));

  // ---- Back ----
  // The panel ignores toggles in its first half second.
  await wait(Math.max(0, 550 - (Date.now() - openedAt)));
  press(KEY.BACK);
  t(n('Back closes the panel'), !isOpen());
  press(KEY.GREEN);
  t(n('green opens it again on the tab that was open'), isOpen() && focused() === tabs()[4] &&
    shortcuts.style.display === 'block', describe(focused()));
  press(KEY.ESC);
  t(n('Escape closes it too'), !isOpen());
  // A second green within the shortcut debounce would be dropped.
  await wait(250);
  press(KEY.GREEN);
  tabs()[0].click();
  if (box) box.focus();
  t(n('open again, the focus in the text box'), isOpen() && !!box && focused() === box, describe(focused()));
  press(KEY.BACK);
  t(n('Back closes it from the text box as well'), !!box && !isOpen());

  t(n('no page errors'), errors.length === 0, errors.join(' | '));
});
