import { aiVideoModes, subtitlesAtStartModes, logoStyles, timeRemainingModes, thumbnailQualityModes, videoCodecModes, uiThemes, clockModes, startPageModes, minVideoLengthModes, seekStepModes, maxVideoAgeModes, searchUploadDateModes, dearrowTitleFormats, dearrowThumbnailFallbacks, forceQualityModes, subtitlePositionModes, subtitleDelayModes, sbMinSegmentLengthModes, searchDurationModes, searchTypeModes, searchFeatureModes } from './config.js';
import { configAddChangeListener, configRead, configWrite, configGetDesc, segmentTypes, configGetDefault, shortcutActions, sbModes, sbModesHighlight, videoPreviewModes, videoQualityDisplayModes, configGetProfileStatus, configResetCounters } from './config.js';
import './ui.css';
import './auto-login.js';
import './return-dislike.js';
import { initVideoQuality } from './video-quality.js';
import { initLogoStyle } from './logo-style.js';
import { initMathLetters } from './math-letters.js';
import { initPlaybackSpeed, stepSpeed, resetSpeed, toggleSpeed } from './playback-speed.js';
import { toggleChannelWhitelist, formatTimeSaved, titleTrayChannel } from './sponsorblock-extras.js';
import { toggleAudioOnly } from './audio-only.js';
import sponsorBlockUI from './Sponsorblock-UI.js';
import { sendKey, REMOTE_KEYS, COLOR_CODE_MAP, isGuestMode, invalidateGuestModeCache, isWatchPage, isShortsPage, isSearchPage, SELECTORS, getVideo, SYNTHETIC_KEY_FLAG, isSyntheticKeyEcho, isAutoplayOn, isLiveStream, rendererChapterStarts } from './utils.js';
import { initTrackingBlock, destroyTrackingBlock } from './adblock.js';
import logoOrangeUrl from './icons/logo-orange.png';
import logoBlueUrl from './icons/logo-blue.png';
import logoRedUrl from './icons/logo-red.png';
import logoDarkUrl from './icons/logo-dark.png';
import { isWebOS25, isLegacyWebOS } from './webos-utils.js';
import { subtitleTranslateLanguages, pickTrack, currentTarget } from './subtitle-translate.js';
import { showNotification, setNotificationOled, setNotificationTheme } from './notifications.js';
import { blockChannel, openFocusedLongPressMenu } from './long-press-menu.js';
import { VERSION_LABEL } from './version.js';
import { buildAboutPage } from './about.js';
import { clearQueue, playNextInQueue } from './video-queue.js';
import { toggleRepeat } from './repeat-video.js';
import { titleFormattingSupported, titleFormatChoices } from './dearrow/index.js';
import { getSidebarEntries, hiddenIds, entryName, SIDEBAR_ENTRIES_EVENT } from './sidebar.js';
import { onWebClientRefused } from './web-client.js';

// YouTube puts every element that scrolls back to its top (a capture "scroll"
// listener on window), which pinned the settings pages there: the remote moved
// the focus below the panel's edge and the page never followed. Registered
// before YouTube's, at load, so it never sees the panel's own scrolling.
window.addEventListener('scroll', (evt) => {
  const target = evt.target;
  if (target instanceof Element && target.closest('.ytaf-ui-container, .ytaf-dialog-backdrop')) evt.stopImmediatePropagation();
}, true);

let lastSafeFocus = null;
let panelReturnFocus = null;
let oledKeepAliveTimer = null;

let lastShortcutTime = 0;
let lastShortcutKey = -1;
let shortcutDebounceTime = 100;
// Burst actions opt out of the debounce so seeks can be repeated quickly, but
// they still have to swallow the duplicate one physical press produces: the
// colour buttons emit two codes that both map to the same name (red 403/166,
// green 404/172, yellow 405/170, blue 406/167/191) in the same tick. No remote
// repeats inside 50ms; a held seek key's repeats go through, so holding it
// keeps seeking.
const BURST_DUPLICATE_MS = 50;

// Seek Burst Variables
let seekAccumulator = 0;
let pendingSeekOffset = 0;
let seekResetTimer = null;
let seekApplyTimer = null;
let activeSeekNotification = null;

let activePlayPauseNotification = null;
// Repeat Video's message: updated, or shown again, by the next press.
let repeatNotification = null;
let playPauseNotificationTimer = null;

// Lazy load variable
let optionsPanel = null;
// The Magic Remote settings button (see showPointerButton). Declared up here
// because applyTheme() runs at load, before that section.
let pointerButton = null;
let optionsPanelVisible = false;
let panelInitBlock = false;

const shortcutCache = {};
// Define keys including colors
const shortcutKeys = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'red', 'green', 'yellow', 'blue'];

const COLOR_KEYS = new Set(['red', 'green', 'yellow', 'blue']);

// The settings panel's tabs, in order. `focus` is what takes focus when the
// tab is opened from inside a page. The old Main tab grew past the height of a
// 1080p screen, so it is split into Filters, Player and Interface.
const SETTINGS_PAGES = [
  { id: 'filters', name: 'Filters', focus: 'input' },
  { id: 'player', name: 'Player', focus: 'input, .shortcut-control-row' },
  { id: 'interface', name: 'Interface', focus: 'input, .shortcut-control-row' },
  { id: 'sponsor', name: 'SponsorBlock', focus: '.shortcut-control-row, input' },
  { id: 'shortcuts', name: 'Shortcuts', focus: '.shortcut-control-row' },
  { id: 'ui-tweaks', name: 'UI Tweaks', focus: '.shortcut-control-row, input' },
  { id: 'about', name: 'About', focus: 'button, input' }
];
const SPONSOR_PAGE = 3;
const ABOUT_PAGE = 6;

const cachedSelectors = {
    comments: null,
    description: null,
    save: null
};

// Candidate lists hoisted to module scope so they aren't rebuilt per keypress.
const COMMENT_SELECTORS = [
    'yt-button-container[aria-label="Comments"]',
    'yt-icon.qHxFAf.ieYpu.nGYLgf',
    'yt-icon.qHxFAf.ieYpu.wFZPnb',
    'ytlr-button-renderer[idomkey="item-1"] ytlr-button',
    '[idomkey="TRANSPORT_CONTROLS_BUTTON_TYPE_COMMENTS"] ytlr-button',
    'ytlr-redux-connect-ytlr-like-button-renderer + ytlr-button-renderer ytlr-button',
    'ytlr-button-renderer[idomkey="1"] yt-button-container'
];
const SAVE_SELECTORS = [
    'yt-button-container[aria-label="Save"]',
    'yt-icon.p9sZp'
];
const DESCRIPTION_FALLBACK_SELECTOR = 'ytlr-button-renderer yt-formatted-string.XGffTd.OqGroe';

// "Try the cached selector, else walk the candidate list, else cache the
// winner" — was hand-rolled three times with subtly different fallback
// behaviour. If a cached selector stops matching we now always fall through to
// the full walk instead of returning null.
function resolveCached(cacheKey, selectors) {
    const cached = cachedSelectors[cacheKey];
    if (cached) {
        const hit = document.querySelector(cached);
        if (hit) return hit;
    }
    for (let i = 0; i < selectors.length; i++) {
        const el = document.querySelector(selectors[i]);
        if (el) {
            cachedSelectors[cacheKey] = selectors[i];
            return el;
        }
    }
    return null;
}

// A player button found by what it does (its icon or the panel it opens), not
// by its label or class: those change with the UI language and YouTube's
// builds. On webOS 25 in Hungarian the comments button is "Megjegyzések" with a
// new icon class, so no selector above matched it.
const panelTargetOf = (d) => d.command && d.command.changeEngagementPanelVisibilityAction && d.command.changeEngagementPanelVisibilityAction.targetId;
const iconTypeOf = (d) => (d.icon && d.icon.iconType) || '';
const isCommentsButton = (d) => iconTypeOf(d) === 'COMMENT' || panelTargetOf(d) === 'comment-item-section';
const isDescriptionButton = (d) => panelTargetOf(d) === 'video-description-ep-identifier';
const isSaveButton = (d) => iconTypeOf(d).indexOf('BOOKMARK') === 0;

function findPlayerButton(match) {
    const renderers = document.querySelectorAll('ytlr-player-actions-container ytlr-button-renderer');
    for (let i = 0; i < renderers.length; i++) {
        const inst = renderers[i].__instance;
        const data = inst && inst.props && inst.props.data;
        if (data && match(data)) return renderers[i].querySelector('yt-button-container, ytlr-button');
    }
    return null;
}

window.addEventListener('ytaf-page-update', (e) => {
    if (e.detail.isWatch) {
        cachedSelectors.comments = null;
        cachedSelectors.description = null;
        cachedSelectors.save = null;
    }
});

const ACTION_SCOPES = {
    config_menu: 'GLOBAL',
    oled_toggle: 'GLOBAL',
    sleep_timer: 'GLOBAL',
    refresh_page: 'NON_VIDEO',
    chapter_skip: 'VIDEO',
    chapter_skip_prev: 'VIDEO',
    seek_15_fwd: 'VIDEO',
    seek_15_back: 'VIDEO',
    play_pause: 'VIDEO',
    toggle_subs: 'VIDEO',
    toggle_comments: 'VIDEO',
    toggle_description: 'VIDEO',
    save_to_playlist: 'VIDEO',
    sb_skip_prev: 'VIDEO',
    sb_manual_skip: 'VIDEO',
    audio_only: 'VIDEO',
    repeat_video: 'VIDEO',
    jump_to_live: 'VIDEO',
    speed_up: 'VIDEO',
    speed_down: 'VIDEO',
    speed_reset: 'VIDEO',
    speed_toggle: 'VIDEO',
    sb_whitelist_channel: 'VIDEO',
    // From any page: the queue is filled on Home, and can be started there.
    queue_next: 'GLOBAL',
    queue_clear: 'GLOBAL',
    // Tiles are on the browse pages and below the player too.
    long_press_menu: 'GLOBAL'
};

function updateShortcutCache(key) {
    shortcutCache[key] = configRead(`shortcut_key_${key}`);
}

// Initialize cache and listeners
shortcutKeys.forEach(key => {
    updateShortcutCache(key);
    configAddChangeListener(`shortcut_key_${key}`, () => updateShortcutCache(key));
});

// --- Helpers ---
// Element#matches / Element#closest polyfills now live in polyfills.js,
// imported via utils.js so every module gets them regardless of import order.

const simulateBack = () => { console.log('[Shortcut] Simulating Back/Escape...'); sendKey(REMOTE_KEYS.BACK); };

// Engagement panel detection. The two renderers are alternative shells YouTube
// uses depending on the panel type (comments/description vs. title-header
// panels); we query both and return whichever exists. Centralized here because
// the same chain was inlined in three shortcut handlers.
const ENGAGEMENT_PANEL_SELECTOR =
    'ytlr-engagement-panel-section-list-renderer, ytlr-engagement-panel-title-header-renderer';
const getEngagementPanel = () => document.querySelector(ENGAGEMENT_PANEL_SELECTOR);
const isEngagementPanelVisible = () => {
    const panel = getEngagementPanel();
    return !!(panel && window.getComputedStyle(panel).display !== 'none');
};

// --- Settings panel navigation ---
//
// The arrows move focus between the tab buttons and the controls of the open
// page by where they sit on screen. This used to be the WICG spatial-navigation
// polyfill (~110 KB, and a focusin listener with a forced layout on every focus
// change in the whole app) for what is a handful of rows; the search below is
// all the panel needs. Ported from mirijanristic's fork (panel/keyboard.js).

// The aligned cycle rows carry a hidden spacer checkbox (dummyBox) - it is
// tabIndex -1 and must never be a target.
const PANEL_FOCUSABLES = 'input:not([disabled]), .shortcut-control-row, button:not([disabled])';

/** The controls of `page` that can take focus, in document order. */
function pageFocusables(page) {
  const out = [];
  if (!page) return out;
  const nodes = page.querySelectorAll(PANEL_FOCUSABLES);
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].tabIndex !== -1) out.push(nodes[i]);
  }
  return out;
}

/**
 * The box a move measures: a checkbox's whole label row (or cycle row), not the
 * small box at its left, which would overlap nothing above or below it.
 */
function boxOf(el) {
  const row = el.tagName === 'INPUT' ? el.closest('label, .shortcut-control-row') : null;
  return (row || el).getBoundingClientRect();
}

/**
 * The candidate nearest to `from` in `dir`, judged by the centres of their
 * boxes (boxOf). Left and Right stay within the row: only candidates that
 * overlap `from` vertically count. Up and Down need a candidate at least half a
 * row ahead - in the two-column Filters section the rows of one line are not
 * quite the same height (the last label's margin stretches its neighbour), and
 * a centre a fraction of a pixel lower must not count as "below". They prefer a
 * candidate that overlaps `from` horizontally but take the nearest one
 * otherwise. Among those, the one closest ahead wins, then the one closest
 * sideways. Returns null when nothing lies that way.
 */
function nearestInDirection(from, dir, candidates) {
  const a = boxOf(from);
  const ax = (a.left + a.right) / 2;
  const ay = (a.top + a.bottom) / 2;
  const vertical = dir === 'up' || dir === 'down';
  const minAhead = vertical ? Math.max(1, a.height / 2) : 0;
  let best = null;
  let bestOverlap = false;
  let bestAhead = Infinity;
  let bestAside = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (el === from) continue;
    const b = boxOf(el);
    if (b.width === 0 && b.height === 0) continue;
    const bx = (b.left + b.right) / 2;
    const by = (b.top + b.bottom) / 2;

    let ahead;
    if (dir === 'up') ahead = ay - by;
    else if (dir === 'down') ahead = by - ay;
    else if (dir === 'left') ahead = ax - bx;
    else ahead = bx - ax;
    if (ahead <= minAhead) continue;

    const aside = vertical ? Math.abs(bx - ax) : Math.abs(by - ay);
    const overlap = vertical
      ? b.right > a.left && b.left < a.right
      : b.bottom > a.top && b.top < a.bottom;
    if (!vertical && !overlap) continue;

    let better;
    if (overlap !== bestOverlap) better = overlap;
    else if (ahead !== bestAhead) better = ahead < bestAhead;
    else better = aside < bestAside;
    if (better) {
      best = el;
      bestOverlap = overlap;
      bestAhead = ahead;
      bestAside = aside;
    }
  }
  return best;
}
const ARROW_KEY_CODE = { 
  [REMOTE_KEYS.LEFT.code]: 'left', 
  [REMOTE_KEYS.UP.code]: 'up', 
  [REMOTE_KEYS.RIGHT.code]: 'right', 
  [REMOTE_KEYS.DOWN.code]: 'down' 
};

// Built from REMOTE_KEYS in utils.js — one source of truth for color codes
// and their per-remote alternates.
const getKeyColor = (charCode) => COLOR_CODE_MAP.get(charCode) || null;

// --- DOM Utility Functions ---

const createElement = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  
  for (const [key, val] of Object.entries(props)) {
      if (key === 'style' && typeof val === 'object') {
          for (const [styleKey, styleVal] of Object.entries(val)) {
              el.style[styleKey] = styleVal;
          }
      }
      else if (key === 'class') el.className = val;
      else if (key === 'events' && typeof val === 'object') {
          for (const [evt, handler] of Object.entries(val)) {
              el.addEventListener(evt, handler);
          }
      }
      else if (key === 'text') el.textContent = val;
      else el[key] = val;
  }

  for (let i = 0; i < children.length; i++) {
      const child = children[i];
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
};

// --- UI Construction Functions ---

function createConfigCheckbox(key) {
  const elmInput = createElement('input', { type: 'checkbox', checked: configRead(key), events: { change: (evt) => configWrite(key, evt.target.checked) }});
  
  // The text sits in its own element: as a bare text node with a leading
  // non-breaking space, a label that wrapped to two lines (two-column
  // sections) indented only its first line, so the second hung to the left.
  const labelText = createElement('span', { class: 'label-text', text: configGetDesc(key) });
  const labelContent = createElement('div', { class: 'label-content', style: { fontSize: '2.1vh' } }, elmInput, labelText);
  const elmLabel = createElement('label', {}, labelContent);
  
  // elmInput.addEventListener('focus', () => elmLabel.classList.add('focused'));
  // elmInput.addEventListener('blur', () => elmLabel.classList.remove('focused'));
  configAddChangeListener(key, (evt) => elmInput.checked = evt.detail.newValue);
  
  return elmLabel;
}

// `variant` is an extra class on the section, used to opt a section into the
// two-column layout. Sizing and spacing moved to ui.css so the whole panel can
// be retuned in one place instead of through inline styles on every section.
function createSection(title, elements, variant) {
  const legend = createElement('div', { text: title, class: 'section-title' });
  const fieldset = createElement('div', { class: 'ytaf-settings-section' + (variant ? ' ' + variant : '') }, legend, ...elements);
  return fieldset;
}

// --- Generic UI Components Factory ---

function createGenericControlRow(labelText, displayValueGetter, onLeft, onRight, onClick, extraElements = null) {
  const valueText = createElement('span', { class: 'current-value' });
  const updateDisplay = () => valueText.textContent = displayValueGetter();

  const container = createElement('div', { 
    class: 'shortcut-control-row',
    style: { padding: '0.6vh 0', margin: '0.2vh 0' }, 
    tabIndex: 0,
    events: {
      keydown: (e) => {
        if (e.keyCode === REMOTE_KEYS.LEFT.code) { onLeft(); e.stopPropagation(); e.preventDefault(); }
        else if (e.keyCode === REMOTE_KEYS.RIGHT.code || e.keyCode === REMOTE_KEYS.ENTER.code) { onRight(); e.stopPropagation(); e.preventDefault(); }
      },
      click: () => onClick()
    }
  },
    createElement('span', { text: labelText, class: 'shortcut-label', style: { fontSize: '2.1vh' } }),
    createElement('div', { class: 'shortcut-value-container' },
      createElement('span', { text: '<', class: 'arrow-btn', events: { click: (e) => { e.stopPropagation(); onLeft(); } } }),
      valueText,
      createElement('span', { text: '>', class: 'arrow-btn', events: { click: (e) => { e.stopPropagation(); onRight(); } } })
    )
  );

  if (extraElements) {
     container.querySelector('.shortcut-value-container').appendChild(extraElements);
  }

  return { container, updateDisplay };
}

function createCycleControl(configKey, labelText, modesArray, displayMap = null, extraElements = null) {
    const displayValueGetter = () => displayMap ? displayMap[configRead(configKey)] || configRead(configKey) : configRead(configKey);
    const cycle = (dir) => {
        let idx = modesArray.indexOf(configRead(configKey));
        if (idx === -1) idx = 0;
        idx = dir === 'next' ? (idx + 1) % modesArray.length : (idx - 1 + modesArray.length) % modesArray.length;
        configWrite(configKey, modesArray[idx]);
        updateDisplay();
    };

    const { container, updateDisplay } = createGenericControlRow(
        labelText, displayValueGetter,
        () => cycle('prev'), () => cycle('next'), () => cycle('next'),
        extraElements
    );

    configAddChangeListener(configKey, updateDisplay);
    updateDisplay();
    return container;
}

/**
 * A cycle control that lines up with the checkbox rows around it.
 *
 * A .shortcut-control-row has no checkbox, so its label starts flush against
 * the row edge while every neighbouring label starts one checkbox-width in. The
 * hidden input below reserves exactly that width, which is cheaper and steadier
 * across themes than hard-coding a padding value that has to track the checkbox
 * CSS by hand.
 */
function createAlignedCycleControl(configKey, displayMap) {
  const control = createCycleControl(configKey, configGetDesc(configKey),
    Object.keys(displayMap), displayMap);
  return alignControlLabel(control, configGetDesc(configKey));
}

/** Lines a .shortcut-control-row's label up with the checkbox rows (see above). */
function alignControlLabel(control, text) {
  const label = control.querySelector('.shortcut-label');
  if (label) {
    label.style.color = 'inherit'; 
    label.style.display = 'flex';
    label.style.alignItems = 'center';
	label.style.lineHeight = 'inherit';
    
    // A spacer only: never a focus target (Up/Down, the wrap-around).
    const dummyBox = createElement('input', {
      tabIndex: -1,
      style: {
        visibility: 'hidden',
        paddingLeft: '2.2vh'
      }
    });
    dummyBox.setAttribute('type', 'checkbox');
    
    label.textContent = '';
    label.appendChild(dummyBox);
    // A margin, not a leading space, so a wrapped second line lines up with the first.
    label.appendChild(createElement('span', { text, style: { marginLeft: '0.25em' } }));
  }

  return control;
}

/**
 * The time SponsorBlock saved, under its settings: "Time saved: 1 h 23 min
 * (456 skips)", kept up to date while the panel is open, with a button that
 * sets it back to nothing.
 */
function createSbStatsLine() {
  const text = createElement('span', {});
  const update = () => {
    const count = Number(configRead('sbSkipCount')) || 0;
    text.textContent = `Time saved: ${formatTimeSaved(configRead('sbTimeSaved'))} (${count} ${count === 1 ? 'skip' : 'skips'})`;
  };
  const reset = createElement('button', {
    class: 'ytaf-list-btn', text: 'Reset', tabIndex: 0,
    events: { click: () => configResetCounters() }
  });
  configAddChangeListener('sbTimeSaved', update);
  configAddChangeListener('sbSkipCount', update);
  update();
  return createElement('div', { class: 'ytaf-sb-stats', style: { padding: '8px 4px 4px 4.3vh' } }, text, reset);
}

const createLogoControl = () => createAlignedCycleControl('logoStyle', logoStyles);
const createVideoCodecControl = () => createAlignedCycleControl('forceVideoCodec', videoCodecModes);

// The per-account switch, with a line under it saying which settings are in
// use. When no account can be told from the identity record, the line lists
// the record's field names (never values) so the case can be reported.
function createPerAccountControl() {
  const control = createConfigCheckbox('perAccountSettings');
  const status = createElement('div', { class: 'ytaf-profile-status', style: { fontSize: '1.7vh', opacity: '0.75', paddingLeft: '4.3vh' } });
  const update = () => {
    const { state, fields } = configGetProfileStatus();
    let text = '';
    if (state === 'account') text = 'Using this account\'s own settings';
    else if (state === 'guest') text = 'Guest: starts from the shared settings each time, changes are not kept';
    else if (state === 'unknown') {
      text = 'Account not recognised - shared settings in use' +
        (fields.length ? ' (fields: ' + fields.join(', ') + ')' : '');
    }
    status.textContent = text;
    status.style.display = text ? '' : 'none';
  };
  configAddChangeListener('perAccountSettings', update);
  window.addEventListener('ytaf-profile-change', update);
  update();
  return createElement('div', {}, control, status);
}

function createSegmentControl(key) {
  const isHighlight = key === 'sbMode_highlight';
  const modesMap = isHighlight ? sbModesHighlight : sbModes;
  const modes = Object.keys(modesMap);
  const colorKey = isHighlight ? 'poi_highlightColor' : key.replace('sbMode_', '') + 'Color';

  const hasColorPicker = segmentTypes[key.replace('sbMode_', '')] || (isHighlight && segmentTypes['poi_highlight']);
  let extraElements = null;

  if (hasColorPicker) {
      const resetButton = createElement('button', { 
          text: 'R', 
          class: 'reset-color-btn', 
          tabIndex: -1,
          events: { 
            click: (evt) => { evt.preventDefault(); evt.stopPropagation(); configWrite(colorKey, configGetDefault(colorKey)); }
          }
      });
      const colorInput = createElement('input', { 
          type: 'color', 
          value: configRead(colorKey), 
          tabIndex: -1,
          events: { 
              click: (evt) => { evt.stopPropagation(); },
              input: (evt) => configWrite(colorKey, evt.target.value) 
          }
      });
      
      configAddChangeListener(colorKey, (evt) => { colorInput.value = evt.detail.newValue; window.sponsorblock?.drawOverlay(); });
      extraElements = createElement('div', { style: { display: 'flex', marginLeft: '10px' } }, resetButton, colorInput);
  }

  return createCycleControl(key, configGetDesc(key), modes, modesMap, extraElements);
}

function createShortcutControl(keyIdentifier) {
  const configKey = `shortcut_key_${keyIdentifier}`;
  const actions = Object.keys(shortcutActions);
  const isColor = COLOR_KEYS.has(keyIdentifier);
  
  const labelText = isColor 
    ? `${keyIdentifier.charAt(0).toUpperCase() + keyIdentifier.slice(1)} Button` 
    : `Key ${keyIdentifier}`;

  return createCycleControl(configKey, labelText, actions, shortcutActions);
}

function createPreviewControl(key) {
  return createAlignedCycleControl(key, videoPreviewModes);
}

// A percentage stepped with Left/Right and clamped at both ends.
function createOpacityControl(key, step = 5, min = 0, max = 100) {
  
  const displayValueGetter = () => `${configRead(key)}%`;
  
  const changeValue = (delta) => {
    let val = configRead(key);
    val = Math.min(max, Math.max(min, val + delta));
    configWrite(key, val);
    updateDisplay();
  };

  const { container, updateDisplay } = createGenericControlRow(
      configGetDesc(key), displayValueGetter,
      () => changeValue(-step), () => changeValue(step), () => changeValue(step)
  );
  
  configAddChangeListener(key, updateDisplay);
  updateDisplay();
  return alignControlLabel(container, configGetDesc(key));
}

// The channel of the video being watched, as the player names it, or ''.
// webOS 25 leaves the player's author empty, so the first item of the
// title tray's metadata line (the channel) is the fallback.
function currentVideoChannel() {
  if (!isWatchPage()) return '';
  const player = document.getElementById(SELECTORS.PLAYER_ID);
  let author = '';
  try {
    const data = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
    if (data && typeof data.author === 'string') author = data.author.trim();
  } catch { /* the tray below */ }
  return author || titleTrayChannel();
}

/**
 * A list setting (Blocked Channels, title keywords): its entries as buttons
 * that remove them, then a text box with an Add button. The text box takes a
 * USB or Bluetooth keyboard, or the TV's own keyboard on OK; OK with text in
 * it adds the text. `channelButton` adds a button that blocks the channel of
 * the video being watched, shown while there is one.
 */
function createListEditor(key, { placeholder, emptyText, channelButton }) {
  const entries = createElement('div', { class: 'ytaf-list-entries' });
  const input = createElement('input', { type: 'text', class: 'ytaf-text-input', placeholder });

  const render = () => {
    entries.textContent = '';
    const values = configRead(key);
    if (!values.length) entries.appendChild(createElement('div', { class: 'ytaf-list-empty', text: emptyText }));
    values.forEach((value, index) => {
      entries.appendChild(createElement('button', {
        class: 'ytaf-list-btn',
        text: '\u2715 ' + value,
        title: 'Remove',
        tabIndex: 0,
        events: { click: () => removeAt(index) }
      }));
    });
  };

  // The focused entry goes away with its button, so the focus moves on to the
  // entry that takes its place, or to the text box.
  const removeAt = (index) => {
    const values = configRead(key).slice();
    values.splice(index, 1);
    configWrite(key, values);
    const buttons = entries.querySelectorAll('.ytaf-list-btn');
    (buttons[Math.min(index, buttons.length - 1)] || input).focus();
  };

  const add = () => {
    const value = input.value.trim();
    input.value = '';
    if (!value) return;
    const values = configRead(key);
    const lower = value.toLowerCase();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i]).toLowerCase() === lower) {
        showNotification((key === 'blockedChannels' ? 'Already blocked: ' : 'Already in the list: ') + value);
        return;
      }
    }
    configWrite(key, values.concat([value]));
  };
  // OK in the text box (the panel's key handler).
  input.ytafSubmit = add;

  const children = [entries];
  if (channelButton) {
    const button = createElement('button', {
      class: 'ytaf-list-btn ytaf-list-action',
      tabIndex: 0,
      events: { click: () => { blockChannel(currentVideoChannel()); input.focus(); } }
    });
    const update = () => {
      const channel = currentVideoChannel();
      const blocked = channel && configRead(key).some((v) => String(v).toLowerCase() === channel.toLowerCase());
      button.textContent = 'Block the Channel of This Video: ' + channel;
      button.style.display = channel && !blocked ? '' : 'none';
    };
    configAddChangeListener(key, update);
    window.addEventListener('ytaf-panel-show', update);
    update();
    children.push(button);
  }
  children.push(createElement('div', { class: 'ytaf-list-input-row' }, input,
    createElement('button', { class: 'ytaf-list-btn', text: 'Add', tabIndex: 0, events: { click: () => { add(); input.focus(); } } })));

  configAddChangeListener(key, render);
  render();
  return createElement('div', { class: 'ytaf-list-editor' },
    createElement('div', { class: 'ytaf-list-title', text: configGetDesc(key) }), ...children);
}

/**
 * Hide Left Menu Entries: a switch for each entry of YouTube's left menu, as
 * it was last loaded (sidebar.js); a ticked one is hidden. The switches are
 * rebuilt when the menu brings other entries, and only ticked or unticked
 * when the setting changes, so the focused one stays.
 */
function createSidebarSection() {
  const KEY = 'hiddenSidebarEntries';
  const hint = createElement('div', { text: 'Ticked entries are taken out of the left menu from the next start of the app. Home always stays', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh', width: '100%' } });
  // In two columns, so the switches are the section's own children.
  const section = createSection('Hide Left Menu Entries', [hint], 'ytaf-section-2col');
  let rows = [];
  let inputs = [];

  const setHidden = (id, hide) => {
    const values = hiddenIds().filter((v) => v !== id);
    if (hide) values.push(id);
    configWrite(KEY, values);
  };
  const sync = () => {
    const hidden = hiddenIds();
    inputs.forEach((input) => { input.checked = hidden.indexOf(input.ytafEntryId) !== -1; });
  };
  const render = () => {
    rows.forEach((row) => { if (row.parentNode) row.parentNode.removeChild(row); });
    rows = [];
    inputs = [];
    const entries = getSidebarEntries();
    if (!entries.length) {
      rows.push(createElement('div', { class: 'ytaf-list-empty', style: { width: '100%' }, text: 'None yet: they show here once YouTube has loaded its left menu.' }));
    }
    entries.forEach((entry) => {
      const input = createElement('input', { type: 'checkbox', events: { change: (evt) => setHidden(entry.id, evt.target.checked) } });
      input.ytafEntryId = entry.id;
      inputs.push(input);
      const labelText = createElement('span', { class: 'label-text', text: entryName(entry) });
      rows.push(createElement('label', {}, createElement('div', { class: 'label-content', style: { fontSize: '2.1vh' } }, input, labelText)));
    });
    rows.forEach((row) => { section.insertBefore(row, hint); });
    sync();
  };

  configAddChangeListener(KEY, sync);
  window.addEventListener(SIDEBAR_ENTRIES_EVENT, render);
  render();
  return section;
}

// --- Main Options Panel Logic ---

function createOptionsPanel() {
  const elmContainer = createElement('div', { 
    class: isGuestMode() ? 'ytaf-ui-container guest-mode' : 'ytaf-ui-container',
    style: { display: 'none' }, 
    tabIndex: 0,
    events: {
      focus: () => console.info('Options panel focused!'),
      blur: () => console.info('Options panel blurred!')
    }
  });

  // Chrome 38 to 59 (webOS 3/4) have no :focus-within, and a selector they do
  // not know drops the whole rule - so the label row of the focused checkbox
  // carries a class instead (ui.css). From mirijanristic's fork.
  const markLabel = (evt, on) => {
    const label = evt.target.closest ? evt.target.closest('label') : null;
    if (label) label.classList.toggle('ytaf-focused', on);
  };
  elmContainer.addEventListener('focusin', (evt) => markLabel(evt, true));
  elmContainer.addEventListener('focusout', (evt) => markLabel(evt, false));

  let activePage = 0;
  elmContainer.activePage = 0;
  // One element per entry of SETTINGS_PAGES, filled as each page is built.
  const pages = [];

  const tabMenu = createElement('div', { 
    class: 'ytaf-tab-menu',
    events: {
      mouseleave: () => {
        const activeTabBtn = tabBtns[activePage];
        if (activeTabBtn && document.activeElement && document.activeElement.classList.contains('ytaf-tab-btn')) {
            activeTabBtn.focus();
        }
      }
    }
  });
  const tabBtns = SETTINGS_PAGES.map(({ name }, index) => createElement('button', {
      class: index === 0 ? 'ytaf-tab-btn active' : 'ytaf-tab-btn',
      text: name,
      tabIndex: 0,
      events: { 
        click: () => setActivePage(index),
        mouseenter: (e) => e.target.focus()
      }
    }));
  tabBtns.forEach(btn => { tabMenu.appendChild(btn); });

	const setActivePage = (pageIndex) => {
	  if (pageIndex === activePage) return; // Don't do work if we are already on this tab
	  ensurePage(pageIndex);   // may still be queued behind the idle build chain
	  // 1. Deactivate old state
	  pages[activePage].style.display = 'none';
	  tabBtns[activePage].classList.remove('active');

	  // 2. Set new state
	  activePage = elmContainer.activePage = pageIndex;
	  pages[activePage].style.display = 'block';
	  tabBtns[activePage].classList.add('active');

	  // 3. Focus management
	  const activeEl = document.activeElement;
	  const isTabFocused = activeEl && activeEl.classList.contains('ytaf-tab-btn');
	  
	  if (!isTabFocused) {
		const focusTarget = pages[activePage].querySelector(SETTINGS_PAGES[activePage].focus);
		if (focusTarget) focusTarget.focus();
	  }
	  
	  // 4. Handle SponsorBlock popup state
	  sponsorBlockUI.togglePopup(activePage === SPONSOR_PAGE && isWatchPage());
	};

  // The tab buttons and the controls of the open page.
  const panelFocusables = () => tabBtns.concat(pageFocusables(pages[activePage]));
  // Focuses a control and scrolls the open page so it is in full view, with
  // half a row of its neighbours: focus() alone does not scroll on every TV.
  // The first and the last control take the page to its top and its end, so
  // what sits above the first or below the last (a heading, a note, the
  // page's padding) comes into view with the arrows too, not only with the
  // Magic Remote wheel. The part in view is the page's box within the panel's.
  const focusInView = (el) => {
    el.focus();
    const page = pages[activePage];
    if (!page || !page.contains(el)) return;
    const shown = pageFocusables(page).filter((c) => c.getClientRects().length > 0);
    if (el === shown[0]) { page.scrollTop = 0; return; }
    if (el === shown[shown.length - 1]) { page.scrollTop = page.scrollHeight; return; }
    const pageBox = page.getBoundingClientRect();
    const panelBox = elmContainer.getBoundingClientRect();
    const top = Math.max(pageBox.top, panelBox.top);
    const bottom = Math.min(pageBox.bottom, panelBox.bottom);
    const row = boxOf(el);
    const margin = row.height / 2;
    if (row.bottom + margin > bottom) page.scrollTop += row.bottom + margin - bottom;
    else if (row.top - margin < top) page.scrollTop -= top - row.top + margin;
  };
  // Up and Down inside a page stay among the page's own controls, and Up
  // reaches the tabs only from the top one. By position on screen alone, a
  // control scrolled up behind the tabs lies farther up than the tabs, so Up
  // went to the tabs and the top of a long page (UI Tweaks) never scrolled
  // back into view; Down from the tabs, measured from a scrolled page, landed
  // in its middle instead of on its first control.
  const moveFocus = (dir) => {
    const from = document.activeElement;
    const page = pages[activePage];
    const vertical = dir === 'up' || dir === 'down';
    if (vertical && page) {
      const controls = pageFocusables(page).filter((c) => c.getClientRects().length > 0);
      let target = null;
      if (tabBtns.indexOf(from) !== -1) {
        if (dir === 'down') target = controls[0] || null;
      } else if (page.contains(from)) {
        target = nearestInDirection(from, dir, controls);
        if (!target && dir === 'up') target = tabBtns[activePage];
      }
      if (target) {
        focusInView(target);
        return;
      }
      if (page.contains(from) || tabBtns.indexOf(from) !== -1) return;
    }
    const target = nearestInDirection(from, dir, panelFocusables());
    if (target) focusInView(target);
  };

  // Keyboard Navigation for the Options Panel
  elmContainer.addEventListener('keydown', (evt) => {
    if (getKeyColor(evt.charCode || evt.keyCode) === 'green') return; // Let global handler handle close if mapped to green (or config_menu logic)

    // A text box keeps the keys it types with, Left and Right included (they
    // move the cursor) until the cursor is at that end of the text, where they
    // move on to the Add button and back; Up and Down still leave it. OK adds
    // what was typed, or with nothing typed is left to the TV, which opens its
    // keyboard.
    const textBox = isTextBox(document.activeElement) ? document.activeElement : null;
    if (textBox) {
      const code = evt.keyCode;
      if (code === REMOTE_KEYS.ENTER.code) {
        if (textBox.value.trim() && textBox.ytafSubmit) {
          textBox.ytafSubmit();
          evt.preventDefault();
        }
        evt.stopPropagation();
        return;
      }
      const isVertical = code === REMOTE_KEYS.UP.code || code === REMOTE_KEYS.DOWN.code;
      const caret = typeof textBox.selectionStart === 'number' ? textBox.selectionStart : 0;
      const leavesBox = (code === REMOTE_KEYS.RIGHT.code && caret >= textBox.value.length) ||
        (code === REMOTE_KEYS.LEFT.code && caret === 0 && textBox.selectionEnd === 0);
      if (!isVertical && !leavesBox && code !== 27 && code !== REMOTE_KEYS.BACK.code) {
        evt.stopPropagation();
        return;
      }
    }

    if (evt.keyCode in ARROW_KEY_CODE) {
      const dir = ARROW_KEY_CODE[evt.keyCode];
      const preFocus = document.activeElement;

      if (dir === 'left' || dir === 'right') {
        // Prevent modifying row from navigating away
        if (preFocus.classList.contains('shortcut-control-row')) return;

        moveFocus(dir);
        
        // Tab menu wrap-around logic
        if (preFocus === document.activeElement && preFocus.classList.contains('ytaf-tab-btn')) {
			const idx = tabBtns.indexOf(preFocus);
			if (dir === 'right' && idx === tabBtns.length - 1) tabBtns[0].focus();
			else if (dir === 'left' && idx === 0) tabBtns[tabBtns.length - 1].focus();
		}

        // Moving along the tabs opens the tab under the focus, so the open tab
        // and the focused one are never two different buttons: Down then leads
        // into the page that is on screen.
        const focusedTab = tabBtns.indexOf(document.activeElement);
        if (focusedTab !== -1) setActivePage(focusedTab);
        
        evt.preventDefault(); evt.stopPropagation(); return;
      } else if (dir === 'up' || dir === 'down') {
        moveFocus(dir);

        if (preFocus === document.activeElement) {
          const activeTabBtn = tabBtns[activePage];
          const focusables = [activeTabBtn].concat(pageFocusables(pages[activePage])).filter(Boolean);
          
          if (focusables.length > 0) {
            if (dir === 'up') focusInView(focusables[focusables.length - 1]);
            else if (dir === 'down') focusInView(focusables[0]);
          }
        }
        evt.preventDefault(); evt.stopPropagation(); return;
      }
    } else if (evt.keyCode === REMOTE_KEYS.ENTER.code) {
      if (evt instanceof KeyboardEvent) document.activeElement.click();
    } else if (evt.keyCode === 27 || evt.keyCode === REMOTE_KEYS.BACK.code) { // Escape / remote Back
      showOptionsPanel(false);
    }
    evt.preventDefault(); evt.stopPropagation();
  }, true);

  const toggleTheme = (evt) => { 
      evt.preventDefault(); 
      evt.stopPropagation(); 
      // Fox -> blue -> red -> Fox.
      const order = Object.keys(uiThemes);
      const next = order[(order.indexOf(configRead('uiTheme')) + 1) % order.length];
      configWrite('uiTheme', next);
      const activeTab = tabBtns[activePage];
      if (activeTab) activeTab.focus();
  };
  // All start hidden; updateLogoState() shows the one for the current theme.
  const createLogo = (src, cls) => createElement('img', { src, alt: 'Logo', class: `ytaf-logo ${cls}`, title: 'Click to switch theme', style: { display: 'none' }, events: { click: toggleTheme }});
  
  const elmHeading = createElement('h1', {},
    createElement('span', { text: 'YouTube Foxtended ' + VERSION_LABEL }),
    createLogo(logoOrangeUrl, 'logo-orange'),
    createLogo(logoBlueUrl, 'logo-blue'),
    createLogo(logoRedUrl, 'logo-red'),
    createLogo(logoDarkUrl, 'logo-dark')
  );
  elmContainer.appendChild(elmHeading);
  elmContainer.appendChild(tabMenu);

  // A page element: the first one visible, the others hidden until their tab
  // is picked. They are appended in build order, which does not matter since
  // only one is ever displayed.
  // The room a page has under the heading and the tabs, so a long page
  // scrolls inside the panel. ui.css says 94vh - 15vh, but the heading and the
  // tabs take more than 15vh, so the bottom rows of a full page were cut off
  // by the panel's edge instead of scrolling into view. Measured when the
  // panel is shown; the pages built later get the same.
  let pageMaxHeight = '';
  const fitPages = () => {
    const screenH = window.innerHeight || document.documentElement.clientHeight || 0;
    const page = pages[activePage];
    if (!screenH || !page) return;
    const frame = window.getComputedStyle(elmContainer);
    const pageStyle = window.getComputedStyle(page);
    // Where the open page starts in the panel: the heading, the tabs and their margins.
    const room = screenH * 0.94 - page.offsetTop -
      (parseFloat(frame.borderTopWidth) || 0) - (parseFloat(frame.borderBottomWidth) || 0) -
      (parseFloat(pageStyle.paddingTop) || 0) - (parseFloat(pageStyle.paddingBottom) || 0);
    if (room < 100) return;
    pageMaxHeight = Math.floor(room) + 'px';
    for (let i = 0; i < pages.length; i++) {
      if (pages[i]) pages[i].style.maxHeight = pageMaxHeight;
    }
  };
  elmContainer.fitPages = fitPages;

  const makePage = (index) => {
    const page = createElement('div', {
      class: 'ytaf-settings-page ytaf-page-sectioned',
      id: `ytaf-page-${SETTINGS_PAGES[index].id}`,
      style: index === 0 ? {} : { display: 'none' }
    });
    pages[index] = page;
    if (pageMaxHeight) page.style.maxHeight = pageMaxHeight;
    elmContainer.appendChild(page);
    return page;
  };

  // --- Page 1: Filters ---
  const pageFilters = makePage(0);
  
  const elAdBlock = createConfigCheckbox('enableAdBlock');
  const elTrackingBlock = createConfigCheckbox('enableTrackingBlock');
  const cosmeticGroup = [elAdBlock, elTrackingBlock];
  const elRemoveGlobalShorts = createConfigCheckbox('removeGlobalShorts');
  const elRemoveLiveVideos = createConfigCheckbox('removeLiveVideos');
  const elRemoveTopLiveGames = createConfigCheckbox('removeTopLiveGames');
  const elRemoveMixes = createConfigCheckbox('removeMixes');
  const elRemoveMostRelevant = createConfigCheckbox('removeMostRelevant');
  const elHideRecommended = createConfigCheckbox('hideRecommendedVideos');
  const elRemoveUpcoming = createConfigCheckbox('removeUpcomingVideos');
  const elRemoveMembersOnly = createConfigCheckbox('removeMembersOnly');
  // Show, Mark or Remove: not greyed out with Ad Blocking off, as Mark works
  // without it. Remove does nothing then, and its value says so.
  const aiVideoLabels = Object.assign({}, aiVideoModes);
  Object.defineProperty(aiVideoLabels, 'remove', {
    enumerable: true,
    get: () => (configRead('enableAdBlock') ? aiVideoModes.remove : aiVideoModes.remove + ' (needs Ad Blocking)')
  });
  const elAiVideos = createAlignedCycleControl('aiVideos', aiVideoLabels);
  elAiVideos.id = 'ytaf-ai-videos';
  configAddChangeListener('enableAdBlock', () => {
    const value = elAiVideos.querySelector('.current-value');
    if (value) value.textContent = aiVideoLabels[configRead('aiVideos')] || configRead('aiVideos');
  });
  let elGuestPrompts = null;
  cosmeticGroup.push(elRemoveGlobalShorts, elRemoveLiveVideos, elRemoveTopLiveGames, elRemoveMostRelevant, elRemoveUpcoming, elRemoveMembersOnly, elRemoveMixes, elHideRecommended, elAiVideos);
  if (isGuestMode()) { elGuestPrompts = createConfigCheckbox('hideGuestSignInPrompts'); cosmeticGroup.push(elGuestPrompts); }

  pageFilters.appendChild(createSection('Cosmetic Filtering', cosmeticGroup, 'ytaf-section-2col'));

  // Dependency Management
  const setState = (el, enabled) => { if (!el) return; const input = el.querySelector('input'); if (input) { input.disabled = !enabled; el.style.opacity = enabled ? '1' : '0.5'; }};

  // Declared after the conditional elGuestPrompts assignment above.
  // setState already no-ops on null, so no filtering needed.
  // Tracking Block rides on the same JSON.parse hook and network hooks as Ad
  // Blocking, so it genuinely does nothing while Ad Blocking is off. Greying it
  // out is what tells the user that, instead of leaving a checkbox that looks
  // armed but is inert.
  const adBlockDependents = [elTrackingBlock, elRemoveGlobalShorts, elRemoveLiveVideos, elRemoveTopLiveGames, elRemoveMostRelevant, elRemoveUpcoming, elRemoveMembersOnly, elRemoveMixes, elHideRecommended, elGuestPrompts];
  const updateDependencyState = () => {
    const enabled = configRead('enableAdBlock');
    adBlockDependents.forEach(el => { setState(el, enabled); });
  };
  
  elAdBlock.querySelector('input').addEventListener('change', updateDependencyState);
  if (elRemoveGlobalShorts) {
    elRemoveGlobalShorts.querySelector('input').addEventListener('change', updateDependencyState);
    configAddChangeListener('removeGlobalShorts', updateDependencyState);
  }
  configAddChangeListener('enableAdBlock', updateDependencyState);
  updateDependencyState();

  // Feed filters. Ad Blocking's like the ones above: greyed out and out of the
  // focus order while it is off. Built in the first frame after the panel is
  // up, with the deferred pages below, so opening the panel does not pay for
  // it; it sits at the bottom of the page, below what the panel opens on.
  let buildFeedSection = () => {
    const feedSection = createSection('Feed Filters', [
      createConfigCheckbox('hideWatchedVideos'),
      createAlignedCycleControl('minVideoLength', minVideoLengthModes),
      createAlignedCycleControl('maxVideoAge', maxVideoAgeModes),
      createConfigCheckbox('hideDuplicateVideos'),
      createListEditor('blockedChannels', {
        placeholder: 'Channel name, then OK',
        emptyText: 'None. Block one here, or with a long press on a video (UI Tweaks tab).',
        channelButton: true
      }),
      createListEditor('blockedKeywords', {
        placeholder: 'A word or phrase, then OK',
        emptyText: 'None.'
      })
    ]);
    pageFilters.appendChild(feedSection);
    const updateFeedSection = () => {
      const enabled = configRead('enableAdBlock');
      feedSection.style.opacity = enabled ? '1' : '0.5';
      const controls = feedSection.querySelectorAll('input, button');
      for (let i = 0; i < controls.length; i++) {
        if (controls[i].tabIndex !== -1 || controls[i].disabled) controls[i].disabled = !enabled;
      }
      const rows = feedSection.querySelectorAll('.shortcut-control-row');
      for (let i = 0; i < rows.length; i++) rows[i].tabIndex = enabled ? 0 : -1;
    };
    configAddChangeListener('enableAdBlock', updateFeedSection);
    // The entries are rebuilt when a list changes.
    configAddChangeListener('blockedChannels', updateFeedSection);
    configAddChangeListener('blockedKeywords', updateFeedSection);
    updateFeedSection();
  };

  // Remember Playback Speed acts only with Playback Speed Control on.
  const elRememberSpeed = createConfigCheckbox('rememberPlaybackSpeed');
  const updateRememberSpeedRow = () => setState(elRememberSpeed, configRead('enablePlaybackSpeed') !== false);
  configAddChangeListener('enablePlaybackSpeed', updateRememberSpeedRow);
  updateRememberSpeedRow();
  // --- Page 2: Player ---
  makePage(1).appendChild(createSection('Video Player',
  [createAlignedCycleControl('forceQuality', forceQualityModes),
  createElement('div', { text: 'Up to: the best quality up to that size; lower applies at once, higher from the next video', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  createConfigCheckbox('removeUpscaledFormats'),
  createElement('div', { text: 'YouTube\'s "Super resolution" levels are upscaled from a smaller video by AI; the real ones play instead', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  createAlignedCycleControl('showVideoQuality', videoQualityDisplayModes),
  createElement('div', { text: 'At Start: a notice with the quality for a few seconds when a video starts. Under Title: a tag after the channel, views and date line', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  createConfigCheckbox('enablePlaybackSpeed'),
  elRememberSpeed,
  createVideoCodecControl(),
  createAlignedCycleControl('subtitleTranslateLang', subtitleTranslateLanguages),
  createAlignedCycleControl('subtitlesAtStart', subtitlesAtStartModes),
  createElement('div', { text: 'Off: no subtitles until you turn them on. Translated: only the Auto-Translate Subtitles language above', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  createAlignedCycleControl('subtitlePosition', subtitlePositionModes),
  createAlignedCycleControl('subtitleDelay', subtitleDelayModes),
  createElement('div', { text: 'For subtitles out of step with the sound. Applies to the next subtitles loaded: turn them off and on again', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  createElement('div', { text: 'Lifts the subtitles, for a TV or soundbar that covers the bottom of the picture. Their font, size and colours are in YouTube\'s own settings, and are kept now', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  createConfigCheckbox('forceOriginalAudio'),
  createConfigCheckbox('audioOnlyStream'),
  createElement('div', { text: 'With the Audio-Only Mode action: only the sound is downloaded and played, not the hidden picture. The video loads again where it is when the mode goes on or off. Only at 1x: at another speed the picture is only hidden', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  createAlignedCycleControl('timeRemainingMode', timeRemainingModes),
  createConfigCheckbox('showMostReplayed'),
  createConfigCheckbox('hideEndcards'),
  createConfigCheckbox('openCommentsAtEnd'),
  createElement('div', { text: 'Only with autoplay off: with it on, opening them would stop the countdown to the next video', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  createConfigCheckbox('enableScrollSeek'),
  createAlignedCycleControl('seekStep', seekStepModes),
  createConfigCheckbox('enableReturnYouTubeDislike')]));
  // The logo in the header also cycles the theme, but a remote cannot focus
  // it, so the setting needs a row of its own to be reachable on a TV.
  // Keep the Clock On During Playback and Show Watch Time mean nothing with the clock off.
  const elClockDuringPlayback = createConfigCheckbox('clockDuringPlayback');
  const elShowWatchTime = createConfigCheckbox('showWatchTime');
  const updateClockRow = () => {
    const clockOn = configRead('clockMode') !== 'off';
    setState(elClockDuringPlayback, clockOn);
    setState(elShowWatchTime, clockOn);
  };
  configAddChangeListener('clockMode', updateClockRow);
  updateClockRow();
  // Auto Login acts only while Bypass Nag Screens is on (auto-login.js).
  const elAutoSelectAccount = createConfigCheckbox('autoSelectAccount');
  const updateAutoLoginRow = () => setState(elAutoSelectAccount, !!configRead('enableAutoLogin'));
  configAddChangeListener('enableAutoLogin', updateAutoLoginRow);
  updateAutoLoginRow();
  const interfaceGroup = [createAlignedCycleControl('uiTheme', uiThemes), createConfigCheckbox('enableAutoLogin'), elAutoSelectAccount, createPerAccountControl(), createAlignedCycleControl('thumbnailQuality', thumbnailQualityModes), createLogoControl(), createAlignedCycleControl('clockMode', clockModes), elClockDuringPlayback, elShowWatchTime, createConfigCheckbox('enableOledCareMode'), createConfigCheckbox('disableNotifications'), createConfigCheckbox('keyboardSearch'), createAlignedCycleControl('searchUploadDate', searchUploadDateModes), createAlignedCycleControl('searchDuration', searchDurationModes), createAlignedCycleControl('searchType', searchTypeModes), createAlignedCycleControl('searchFeature', searchFeatureModes), createConfigCheckbox('pointerSettingsButton'), createConfigCheckbox('disableAnimations'), createConfigCheckbox('keepAppOpenWhenPaused')];
  // The cast block only exists on webOS 25 (see userScript.js).
  if (isWebOS25()) interfaceGroup.push(createConfigCheckbox('blockWebosCast'));
  // --- Page 3: Interface ---
  makePage(2).appendChild(createSection('Interface', interfaceGroup));

  // --- Pages 4-6: built off the critical path ---
  //
  // Only the first three pages (the old Main page) are built up front -
  // building every page inside the keydown handler cost 170ms on webOS 3, most
  // of it on display:none pages. The rest build one per animation frame once
  // the panel is up, and setActivePage() forces a synchronous build if the user
  // beats the chain.
  const pageBuilders = [
    null,
    null,
    null,
    function buildSponsorPage() {
  // --- Page 4: SponsorBlock ---
    const pageSponsor = makePage(SPONSOR_PAGE);
    pageSponsor.classList.remove('ytaf-page-sectioned');
    pageSponsor.appendChild(createConfigCheckbox('enableSponsorBlock'));
  
    const elmBlock = createElement('blockquote', {},
      ...['Sponsor', 'Intro', 'Outro', 'Interaction', 'SelfPromo', 'MusicOfftopic', 'Filler', 'Hook', 'Preview'].map(s => createSegmentControl(`sbMode_${s.toLowerCase()}`)),
      createSegmentControl('sbMode_highlight'),
      createConfigCheckbox('enableMutedSegments'),
      createConfigCheckbox('sbPeriodicRefresh'),
  	createConfigCheckbox('skipSegmentsOnce'),
      createConfigCheckbox('sbFullVideoLabel'),
      createConfigCheckbox('sbShowTimeWithSkips'),
      createAlignedCycleControl('sbMinSegmentLength', sbMinSegmentLengthModes),
      createConfigCheckbox('sbCommunityChapters'),
      createElement('div', { text: 'Skip to Next/Previous Chapter goes by the chapters SponsorBlock users made, on a video with none of its own', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
      createConfigCheckbox('sbReportSkips'),
      createElement('div', { text: 'Tells sponsor.ajay.app which segments were skipped (their ids only), for the counts SponsorBlock shows their submitters', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
      createListEditor('sbWhitelistChannels', {
        placeholder: 'Channel name, then OK',
        emptyText: 'None. A key set to "SponsorBlock: Never Skip on This Channel" adds the channel playing.'
      }),
      createSbStatsLine()
    );
    pageSponsor.appendChild(elmBlock);
    pageSponsor.appendChild(createElement('div', {}, createElement('small', { text: 'Sponsor segments skipping - https://sponsor.ajay.app' })));

      },
    function buildShortcutsPage() {
  // --- Page 5: Shortcuts ---
    const pageShortcuts = makePage(4);
    pageShortcuts.classList.remove('ytaf-page-sectioned');
    shortcutKeys.forEach(key => { pageShortcuts.appendChild(createShortcutControl(key)); });
  
      },
    function buildUITweaksPage() {
  // --- Page 6: UI Tweaks ---
    const pageUITweaks = makePage(5);
  
    // The shelf opacity is a rule of OLED-Care Mode's: greyed out and out of
    // the focus order while that is off, like DeArrow's cycle rows.
    const shelfOpacity = createOpacityControl('videoShelfOpacity');
    const syncShelfOpacity = () => {
      const on = !!configRead('enableOledCareMode');
      shelfOpacity.style.opacity = on ? '1' : '0.5';
      shelfOpacity.tabIndex = on ? 0 : -1;
    };
    configAddChangeListener('enableOledCareMode', syncShelfOpacity);
    syncShelfOpacity();
    const playerUITweaks = [
        shelfOpacity,
        createElement('div', { text: 'Adjusts opacity of black background underneath videos (Requires OLED-care mode)', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
        createOpacityControl('uiBrightness', 10, 40, 100),
        createElement('div', { text: 'Dims the YouTube menus and thumbnails; never the playing video or this panel', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  	  createPreviewControl('videoPreviews'),
  	  createElement('div', { text: 'Default leaves the previews to YouTube\'s own setting. Off and With sound set it; Without sound turns previews on and mutes them. No effect where YouTube shows no previews', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  	  createConfigCheckbox('continuePreviews'),
  	  createElement('div', { text: 'OK on a tile whose preview is playing carries that playback on, full screen, instead of loading the video again', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  	  ...(isLegacyWebOS() ? [
  	    createConfigCheckbox('fixBlackPreviews'),
  	    createElement('div', { text: 'Shows the picture of a tile preview that plays its sound over a black tile (webOS 3-6)', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } })
  	  ] : []),
  	  createConfigCheckbox('fitPageBesideGuide'),
  	  createElement('div', { text: 'Shrinks the page beside the open left menu, instead of pushing its right side off the screen', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  	  createConfigCheckbox('removeLowMemoryStyle'),
  	  createElement('div', { text: 'Takes away the black boxes YouTube puts behind the player\'s titles and timestamps when it saves memory', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
  	  createConfigCheckbox('removeBlackBorders')
    ];

    pageUITweaks.appendChild(createSection('Player UI Tweaks', playerUITweaks));

    // Where the app starts and what the tiles and their menus show. On this
    // page, which has room, as the Interface page is full.
    pageUITweaks.appendChild(createSection('Browsing', [
      createAlignedCycleControl('startPage', startPageModes),
      createConfigCheckbox('extendLongPressMenu')
    ]));

    pageUITweaks.appendChild(createSidebarSection());

    // DeArrow: the switch and the logo, then the title and thumbnail options,
    // greyed out while it is off (and the thumbnail fallback while
    // crowdsourced thumbnails are). Its own section here rather than a tab:
    // a seventh tab does not fit the panel's width. The legacy build has
    // Title Case alone (dearrow/formatter-legacy.js).
    const elDeArrowBadge = createConfigCheckbox('dearrowShowBadge');
    const deArrowTitleRows = [createConfigCheckbox('dearrowCrowdTitles'), createConfigCheckbox('dearrowCasualMode'),
      createElement('div', { text: 'Keeps YouTube\'s own title where DeArrow\'s casual voters found it fine (funny, clever, descriptive...), instead of a crowdsourced one. Where YouTube shows titles translated, it needs Untranslated Titles on: the votes are for the title as uploaded', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } }),
      createConfigCheckbox('dearrowUntranslatedTitles'),
      createElement('div', { text: 'YouTube\'s titles as their uploader wrote them, where YouTube shows them translated into your language. One request to YouTube per video shown; with Crowdsourced Titles off, only this', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } })];
    if (titleFormattingSupported) {
      deArrowTitleRows.push(
        createAlignedCycleControl('dearrowTitleFormatting', titleFormatChoices(dearrowTitleFormats)),
        createConfigCheckbox('dearrowCleanEmojis')
      );
    }
    const elDeArrowFallback = createAlignedCycleControl('dearrowThumbnailFallback', dearrowThumbnailFallbacks);
    const elDeArrowFallbackHelp = createElement('div', { text: 'Random Frame: a frame DeArrow picks from the video; for it the id of every video shown is sent to DeArrow\'s servers, with the other choices only of videos that have a crowdsourced thumbnail. Start, middle and end frames: YouTube\'s own', style: { color: '#aaa', fontSize: '18px', padding: '4px 12px 12px 4.3vh' } });
    const deArrowThumbRows = [createConfigCheckbox('dearrowCrowdThumbnails'), elDeArrowFallback, elDeArrowFallbackHelp];
    pageUITweaks.appendChild(createSection('DeArrow', [
      createConfigCheckbox('enableDeArrow'),
      elDeArrowBadge,
      ...deArrowTitleRows,
      ...deArrowThumbRows,
      createElement('div', {}, createElement('small', { text: 'Crowdsourced titles and thumbnails, in place of clickbait - https://dearrow.ajay.app' }))
    ]));
    const updateDeArrowRows = () => {
      const on = !!configRead('enableDeArrow');
      const thumbsOn = !!configRead('dearrowCrowdThumbnails');
      [elDeArrowBadge, ...deArrowTitleRows, ...deArrowThumbRows].forEach((row) => {
        const fallbackRow = row === elDeArrowFallback || row === elDeArrowFallbackHelp;
        const enabled = on && (!fallbackRow || thumbsOn);
        if (row.classList.contains('shortcut-control-row')) {
          // A cycle row: greyed out and out of the focus order.
          row.style.opacity = enabled ? '1' : '0.5';
          row.tabIndex = enabled ? 0 : -1;
        } else if (row.querySelector('input')) {
          setState(row, enabled);
        } else {
          row.style.opacity = enabled ? '1' : '0.5';
        }
      });
    };
    configAddChangeListener('enableDeArrow', updateDeArrowRows);
    configAddChangeListener('dearrowCrowdThumbnails', updateDeArrowRows);
    updateDeArrowRows();

      },
    function buildAbout() {
  // --- Page 7: About (about.js) ---
    const pageAbout = makePage(ABOUT_PAGE);
    buildAboutPage(pageAbout, createElement, createConfigCheckbox, createSection);
      }
  ];

  const ensurePage = (index) => {
    const build = pageBuilders[index];
    if (!build) return;
    pageBuilders[index] = null;   // clear first: a builder must never run twice
    build();
  };
  elmContainer.ensurePage = ensurePage;

  // Chain the remaining builders one per frame so no single frame does all of
  // it. Bails out early if the user already forced them via a tab press.
  elmContainer.buildDeferredPages = () => {
    let index = 1;
    const step = () => {
      if (buildFeedSection) {
        const build = buildFeedSection;
        buildFeedSection = null;
        build();
        requestAnimationFrame(step);
        return;
      }
      while (index < pageBuilders.length && !pageBuilders[index]) index++;
      if (index >= pageBuilders.length) return;
      ensurePage(index++);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  return elmContainer;
}

// Lazy Load: optionsPanel is not created here.
// document.body.appendChild(optionsPanel); removed

/** Ends the OLED blackout, if it is on. */
function endOledBlackout() {
  const overlay = document.getElementById('oled-black-overlay');
  if (!overlay) return false;
  overlay.remove();
  document.documentElement.classList.remove('ytaf-oled-blackout');
  if (oledKeepAliveTimer) { clearInterval(oledKeepAliveTimer); oledKeepAliveTimer = null; }
  return true;
}

function showOptionsPanel(visible) {
  if (panelInitBlock) {
      console.log('[UI] Options panel toggle blocked due to initialization lock.');
      return;
  }
  if (visible === undefined || visible === null) visible = true;
  
  if (visible && !optionsPanelVisible) {
    panelReturnFocus = document.activeElement;
    // The blackout sits above the panel, which would open unseen.
    endOledBlackout();

    // Lazy Initialization
    if (!optionsPanel) {
        console.log('[UI] Initializing Options Panel (Lazy Load)...');
		panelInitBlock = true;
        setTimeout(() => { panelInitBlock = false; }, 500);
        optionsPanel = createOptionsPanel();
        document.body.appendChild(optionsPanel);
        
        // Apply startup states that depend on panel existence
        applyOledMode(configRead('enableOledCareMode'));
        applyTheme(configRead('uiTheme'));
    }

    console.info('Showing and focusing options panel!');
    optionsPanel.style.display = 'block';
    // Measured in the next frame, not here: the measuring forces a layout,
    // which would hold up the key press that opens the panel.
    requestAnimationFrame(optionsPanel.fitPages);
    // Rows that depend on the page under the panel (the video's channel).
    window.dispatchEvent(new CustomEvent('ytaf-panel-show'));
    // The other three tabs are built here, one per frame, now that the panel is
    // on screen. Doing it inside the keydown handler is what made opening the
    // panel a 170ms freeze on webOS 3.
    if (optionsPanel.buildDeferredPages) optionsPanel.buildDeferredPages();
    if (optionsPanel.activePage === SPONSOR_PAGE && (isWatchPage())) sponsorBlockUI.togglePopup(true);
    else sponsorBlockUI.togglePopup(false);
    
    // Find best initial focus
    const activeTabBtn = optionsPanel.querySelector('.ytaf-tab-btn.active');
    if (activeTabBtn) {
        activeTabBtn.focus();
        lastSafeFocus = activeTabBtn;
    } else {
        optionsPanel.focus();
        lastSafeFocus = optionsPanel;
    }
    optionsPanelVisible = true;
  } else if (!visible && optionsPanelVisible && optionsPanel) {
    console.info('Hiding options panel!');
    optionsPanel.style.display = 'none';
    sponsorBlockUI.togglePopup(false);
    optionsPanel.blur();
    optionsPanelVisible = false;
    lastSafeFocus = null;
    const returnFocus = panelReturnFocus;
    panelReturnFocus = null;
    // Release the trap before restoring the page's focus. YouTube may have
    // replaced the original tile while the panel was open.
    if (returnFocus && returnFocus.isConnected && !optionsPanel.contains(returnFocus)) {
      returnFocus.focus();
    }
    // Also when that focus() did nothing (the page disabled the element): the
    // hidden panel must not keep the focus.
    if (optionsPanel.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    // A held Back (or whichever key closed the panel) must not go on to
    // YouTube as a page back.
    swallowHeldKey();
    // The binding may have changed while the panel was open: if no key opens
    // it any more, Green does again.
    ensureMenuKey(true);
  }
}

// Trap focus inside options panel when visible
document.addEventListener('focus', (e) => {
  if (!optionsPanelVisible || !optionsPanel) return;
  const target = e.target;
  const isSafeFocus = (optionsPanel && optionsPanel.contains(target)) || (target.closest && target.closest('.sb-segments-popup'));
  if (isSafeFocus) lastSafeFocus = target;
  else {
    e.stopPropagation();
    e.preventDefault();
    if (lastSafeFocus && lastSafeFocus.isConnected) lastSafeFocus.focus();
    else {
      const firstVisibleInput = optionsPanel.querySelector('.ytaf-tab-btn.active, .ytaf-settings-page[style*="block"] input:not([disabled]), .ytaf-settings-page[style*="block"] .shortcut-control-row');
      if (firstVisibleInput) firstVisibleInput.focus();
      else optionsPanel.focus();
    }
  }
}, true);

window.ytaf_showOptionsPanel = showOptionsPanel;

// --- Video Control Logic ---

// Delayed remote actions belong to one playback context. YouTube reuses the
// <video> across navigation, so neither the element nor its src alone is enough.
let playbackActionGeneration = 0;
let seekContext = null;

function playbackVideoId() {
  try {
    const player = document.getElementById(SELECTORS.PLAYER_ID);
    const data = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
    // Anything but a string is unreadable: a fresh object on each call would
    // never compare equal.
    return data && typeof data.video_id === 'string' ? data.video_id : '';
  } catch { return ''; }
}

function capturePlaybackContext(video) {
  const generation = playbackActionGeneration;
  const route = window.location.hash;
  const src = video.currentSrc || video.src;
  let id = playbackVideoId();
  // An id the player cannot give (now or then) is no change: the route, the
  // element and its source still decide. The first id read is kept, so a
  // later different one is a change even when the capture could not read it.
  const sameId = (now) => {
    if (!now) return true;
    if (!id) id = now;
    return now === id;
  };
  return () => generation === playbackActionGeneration && video.isConnected &&
    (isWatchPage() || isShortsPage()) && getVideo() === video &&
    window.location.hash === route && (video.currentSrc || video.src) === src && sameId(playbackVideoId());
}

function resetPendingSeek() {
  clearTimeout(seekApplyTimer);
  clearTimeout(seekResetTimer);
  seekApplyTimer = seekResetTimer = null;
  seekAccumulator = pendingSeekOffset = 0;
  seekContext = null;
  if (activeSeekNotification) activeSeekNotification.remove();
  activeSeekNotification = null;
}

function cancelDelayedPlaybackActions() {
  playbackActionGeneration++;
  resetPendingSeek();
  // A chapter lookup waiting for the old playback lets go: a press on the new
  // one is taken, and may send its own Enter.
  if (skipChapter.loading) {
    skipChapter.loading = null;
    skipChapter.hasForced = false;
  }
}
window.addEventListener('hashchange', cancelDelayedPlaybackActions);
window.addEventListener('ytaf-page-update', cancelDelayedPlaybackActions);

/**
 * The chapters' start times in seconds. The bar renderer's data has them
 * (chapters[].start); the widths of the bar's chapter elements are the
 * fallback: whole pixels, so a few seconds off on a short video, and on a
 * long one the bar draws only some of the chapters (50 of 71 on a 4.7-hour
 * video, read on the TV), which put the skip minutes off.
 */
function chapterStarts(chapterEls, duration) {
  const starts = rendererChapterStarts();
  if (starts.length) return starts;
  const widths = [];
  let total = 0;
  for (let i = 0; i < chapterEls.length; i++) {
    if (chapterEls[i].getAttribute('idomkey')?.startsWith('chapter-')) {
      const width = parseFloat(chapterEls[i].style.width || '0');
      widths.push(width);
      total += width;
    }
  }
  if (!total) return [];
  let at = 0;
  return widths.map((width) => {
    const start = (at / total) * duration;
    at += width;
    return start;
  });
}

/**
 * Skip to Next/Previous Chapter on a video with no chapters of its own: the
 * community's chapters from SponsorBlock (sponsorblock.js communityChapters),
 * with Use Community Chapters on. Their starts and ends are the stops; the
 * chapter's name comes with the notice. False when there are none.
 */
function skipCommunityChapter(video, direction) {
  if (!configRead('sbCommunityChapters') || !window.sponsorblock ||
      typeof window.sponsorblock.communityChapters !== 'function') return false;
  const chapters = window.sponsorblock.communityChapters();
  if (!chapters.length) return false;
  const stops = [0];
  for (const chapter of chapters) stops.push(chapter.start, chapter.end);
  const sorted = stops.filter((at, i, all) => at < video.duration && all.indexOf(at) === i).sort((a, b) => a - b);
  const now = video.currentTime;
  let target = -1;
  if (direction === 'next') {
    target = sorted.find((at) => at > now + 1);
    if (target === undefined) target = -1;
  } else {
    let current = 0;
    let previous = 0;
    for (const at of sorted) {
      if (at > now) break;
      previous = current;
      current = at;
    }
    target = now - current > 3 ? current : previous;
  }
  if (target === -1) {
    showNotification(direction === 'next' ? 'No next chapter' : 'Start of video');
    return true;
  }
  video.currentTime = target;
  const chapter = chapters.find((c) => c.start === target);
  const label = direction === 'next' ? 'Next Chapter' : 'Previous Chapter';
  showNotification(chapter && chapter.name ? `${label}: ${chapter.name}` : label);
  return true;
}

async function skipChapter(direction = 'next') {
  if(isShortsPage()) return;
  // A press during the wait below would find no chapters yet.
  if (skipChapter.loading) return;
  const video = getVideo();
  if (!video || !video.duration) return;

  skipChapter.hasForced = skipChapter.hasForced || false;

  // Another video: another address or source, or another readable id. An id
  // the player cannot give now is no change (the last readable one stays).
  const base = `${window.location.href}|${video.currentSrc || video.src}`;
  const id = playbackVideoId();
  const isCurrent = capturePlaybackContext(video);
  const closeForcedControls = () => {
    setTimeout(() => { if (isCurrent() && !optionsPanelVisible) simulateBack(); }, 250);
  };
  let wasForcedNow = false;
  
  if (skipChapter.lastBase !== base || (id && skipChapter.lastId && id !== skipChapter.lastId)) {
    skipChapter.lastBase = base;
    skipChapter.lastId = id;
    skipChapter.hasForced = false;
  } else if (id) skipChapter.lastId = id;

  const getChapterEls = () => {
    const bar = document.querySelector('ytlr-multi-markers-player-bar-renderer [idomkey="progress-bar"]');
    if (!bar) return [];
    // Avoid creating an array copy if possible, but structure might require it. 
    // Using bar.children directly in loop below.
    return bar.children;
  };

  let chapterEls = getChapterEls();

  // Hack: Force UI to load chapters if they aren't in DOM
  if (chapterEls.length === 0 && !skipChapter.hasForced) {
    console.log('[Chapters] No chapters found. Forcing UI...');
    skipChapter.hasForced = true;
    wasForcedNow = true;
    showNotification('Loading chapters...');
    sendKey(REMOTE_KEYS.ENTER);
    const lookup = {};
    skipChapter.loading = lookup;
    await new Promise(resolve => setTimeout(resolve, 500));
    // Released by a navigation: a newer lookup may own the state by now.
    if (skipChapter.loading !== lookup) return;
    skipChapter.loading = null;
    // Another playback by now (A -> B -> A included): the Enter loaded nothing
    // for this one, so the next press may send it again.
    if (!isCurrent()) {
      skipChapter.hasForced = false;
      return;
    }
    chapterEls = getChapterEls();
  }

  const currentTime = video.currentTime;
  // The renderer's own start times count even with no marker elements mounted.
  const starts = chapterStarts(chapterEls, video.duration);

  // No chapters of its own.
  if (starts.length === 0) {
    if (!skipCommunityChapter(video, direction)) showNotification('No chapters found');
    if (wasForcedNow) closeForcedControls();
    return;
  }

  let targetTime = -1;
  let currentChapterStart = 0;
  let prevChapterStart = 0;

  for (let i = 0; i < starts.length; i++) {
      const startTimestamp = starts[i];

      if (direction === 'next') {
        if (startTimestamp > currentTime + 1) {
            targetTime = startTimestamp;
            break;
        }
      } else if (currentTime >= startTimestamp) {
        // Prev logic
        prevChapterStart = currentChapterStart;
        currentChapterStart = startTimestamp;
      } else {
        // Passed current time
        break;
      }
  }
  
  // Finalize Previous Target
  if (direction !== 'next') {
      if (currentTime - currentChapterStart > 3) targetTime = currentChapterStart;
      else targetTime = prevChapterStart;
  }

  if (targetTime !== -1 && targetTime < video.duration) {
    video.currentTime = targetTime;
    showNotification(direction === 'next' ? 'Next Chapter' : 'Previous Chapter');
    if (wasForcedNow) closeForcedControls();
  } else {
    showNotification(direction === 'next' ? 'No next chapter' : 'Start of video');
    if (wasForcedNow) closeForcedControls();
  }
}

function performBurstSeek(seconds, video) {
    if (!video) video = getVideo();
    if (!video) return;
    if (seekContext && !seekContext()) resetPendingSeek();
    if (!seekContext) seekContext = capturePlaybackContext(video);
	
    // Reset accumulators if direction changes (e.g. going from +15 to -15)
	if ((seekAccumulator > 0 && seconds < 0) || (seekAccumulator < 0 && seconds > 0)) {
        // Only the toast's running total restarts; the part not applied to
        // the video yet still counts (+5, +5, -5 must move +5, not -5).
        seekAccumulator = 0;
    }

    seekAccumulator += seconds;
    pendingSeekOffset += seconds; // Add to the queue, don't apply to video yet

    // Reset the "UI Fade Out" timer
    if (seekResetTimer) clearTimeout(seekResetTimer);

    // Update UI immediately (lightweight operation)
    const directionSymbol = seekAccumulator > 0 ? '+' : '';
    const msg = `Skipped ${directionSymbol}${seekAccumulator}s`;

    if (activeSeekNotification) {
         activeSeekNotification.update(msg);
    } else {
         activeSeekNotification = showNotification(msg);
    }

    // Debounce the heavy video seek operation
    if (seekApplyTimer) clearTimeout(seekApplyTimer);

    seekApplyTimer = setTimeout(() => {
        seekApplyTimer = null;
        if (!seekContext || !seekContext()) { resetPendingSeek(); return; }
        if (pendingSeekOffset !== 0) {
            // Apply the total calculated seek in one single operation
            video.currentTime += pendingSeekOffset;
            pendingSeekOffset = 0;
        }
    }, 200); // 200ms buffer allows rapid key presses without freezing the UI

    seekResetTimer = setTimeout(() => {
        seekAccumulator = 0;
        activeSeekNotification = null;
        seekResetTimer = null;
        seekContext = null;
    }, 1200);
}

// --- Magic Remote scroll-wheel seeking ---
// While the progress bar has focus, each wheel notch seeks: up is forward,
// down is back. Anywhere else the wheel keeps scrolling as before. Ported from
// jesvijonathan's fork, onto the burst-seek path so rapid notches coalesce
// into one seek and one notification.
const SCROLL_SEEK_STEP_S = 10;
// webOS 25 marks the focused bar with zylon-focus only.
const isProgressBarFocused = () => !!document.querySelector('ytlr-progress-bar.ytLrProgressBarFocused, ytlr-progress-bar[focused], ytlr-progress-bar.zylon-focus');

function handleScrollSeek(evt) {
    if (!configRead('enableScrollSeek') || optionsPanelVisible) return;
    if (!isWatchPage() || !evt.deltaY || !isProgressBarFocused()) return;
    const video = getVideo();
    if (!video || !video.duration) return;
    evt.preventDefault();
    evt.stopPropagation();
    performBurstSeek(evt.deltaY > 0 ? -SCROLL_SEEK_STEP_S : SCROLL_SEEK_STEP_S, video);
}

window.addEventListener('wheel', handleScrollSeek, { passive: false, capture: true });

// --- Left/Right Seek Step ---
// While the player controls are hidden, Left and Right seek by the chosen step
// instead of YouTube's own, on the burst-seek path, so quick presses add up to
// one seek. With the controls on screen they move along the controls as
// before. (From MickLesk's fork.)
let seekStepKeyCode = null;

// Taken as shown unless the controls are found and neither active nor holding
// the focus: wrongly taking Left and Right from the controls is worse than
// leaving them to YouTube.
function playerControlsShown() {
  const controls = document.querySelector('yt-focus-container[idomkey="controls"]');
  if (!controls) return true;
  return controls.classList.contains('zylon-focus') || controls.contains(document.activeElement);
}

function handleSeekStepKey(evt) {
  if (isSyntheticKey(evt)) return;
  const code = evt.keyCode;
  if (code !== REMOTE_KEYS.LEFT.code && code !== REMOTE_KEYS.RIGHT.code) return;
  if (evt.type === 'keyup') {
    // The keyup of a press we seeked with is ours too.
    if (code === seekStepKeyCode) {
      seekStepKeyCode = null;
      evt.preventDefault();
      evt.stopImmediatePropagation();
    }
    return;
  }
  // A press that is not taken below is YouTube's, and so is its keyup: a
  // keyup we never got (the panel opened meanwhile) must not leave the next
  // one of this key swallowed.
  seekStepKeyCode = null;
  const step = Number(configRead('seekStep')) || 0;
  if (!step || optionsPanelVisible || !isWatchPage() || isShortsPage()) return;
  if (isTextBox(document.activeElement) || playerControlsShown() || isEngagementPanelVisible()) return;
  const video = getVideo();
  if (!video || !video.duration) return;
  evt.preventDefault();
  evt.stopImmediatePropagation();
  seekStepKeyCode = code;
  performBurstSeek(code === REMOTE_KEYS.RIGHT.code ? step : -step, video);
}

window.addEventListener('keydown', handleSeekStepKey, true);
window.addEventListener('keyup', handleSeekStepKey, true);

function triggerInternal(element, name) {
  if (!element) return false;
  let success = false;
  try { element.click(); console.log(`[Shortcut] Standard click triggered for ${name}`); success = true; } 
  catch (e) { console.warn(`[Shortcut] Standard click failed for ${name}:`, e); }
  
  // Try to access internal React/Polymer instance for robust clicking
  const instance = element.__instance;
  if (instance && typeof instance.onSelect === 'function') {
    console.log(`[Shortcut] Also calling internal onSelect() for ${name}`);
    try {
      const mockEvent = { type: 'click', stopPropagation: () => {}, preventDefault: () => {}, target: element, currentTarget: element, bubbles: true, cancelable: true };
      instance.onSelect(mockEvent);
      success = true;
    } catch (e) { console.warn(`[Shortcut] Internal call failed for ${name}:`, e); }
  }
  return success;
}

// --- Shortcut Helper Functions (Static Logic) ---
// Extracted to prevent object allocation inside handlers

// A name's text: a string, { simpleText } or { runs }, as YouTube gives it
// (subtitle-translate.js's own tracks too); '' when it has none.
function nameText(name) {
    if (typeof name === 'string') return name;
    if (name && typeof name.simpleText === 'string') return name.simpleText;
    if (name && Array.isArray(name.runs)) return name.runs.map((run) => (run && typeof run.text === 'string' ? run.text : '')).join('');
    return '';
}

// The notice for a track switched on: its first name with text, else its
// language code, else no name at all.
function subtitlesOnNotice(track) {
    const names = [track.languageName, track.name, track.trackName, track.languageCode];
    for (let i = 0; i < names.length; i++) {
        const text = nameText(names[i]);
        if (text) return `Subtitles: ON (${text})`;
    }
    return 'Subtitles: ON';
}

// A list entry that can be switched on as it is: a track that names itself
// (a language code or a vss id), not a translation entry (as pickTrack takes
// them). An empty object is what switches the subtitles off.
function usableTrack(track) {
    if (!track || typeof track !== 'object' || Array.isArray(track) || track.translationLanguage) return false;
    const ids = [track.languageCode, track.vssId, track.vss_id];
    return ids.some((id) => typeof id === 'string' && id !== '');
}

// The video's own caption tracks that can be switched on (the player's list
// can lack one, such as the auto-translated copy subtitle-translate.js adds).
function videoCaptionTracks(player) {
    // A player still starting can throw here: no tracks then, and the
    // player's own choice (toggleSubtitlesOn) is still tried.
    let videoData = null;
    try { videoData = typeof player.getVideoData === 'function' ? player.getVideoData() : null; } catch { /* not ready */ }
    return videoData && Array.isArray(videoData.captionTracks) ? videoData.captionTracks.filter(usableTrack) : [];
}

// The tracks to choose from, only those that can be switched on: the
// player's list, else the video's caption tracks (the captions API can answer
// before it has a list, or one with no track in it that can be switched on).
function captionTracks(player, trackList) {
    if (Array.isArray(trackList) && trackList.some(usableTrack)) return trackList.filter(usableTrack);
    return videoCaptionTracks(player);
}

// A track to switch on when the player cannot choose one itself: in the TV's
// language, picked as Subtitles When a Video Starts picks (pickTrack: its own
// words before speech recognition), its region or script first (zh-TW, then
// zh); else the video's default; else the first. No translation entry in any
// of the three. The first alone is no choice: the list is in alphabetical
// order (Afrikaans first on a TED talk with many translations, measured on
// the TV).
function pickCaptionTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const tag = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase();
    const base = tag.split('-')[0];
    const inTvLanguage = (tag ? pickTrack(tracks, tag) : null) || (base && base !== tag ? pickTrack(tracks, base) : null);
    if (inTvLanguage) return inTvLanguage;
    for (let i = 0; i < tracks.length; i++) if (usableTrack(tracks[i]) && (tracks[i].is_default || tracks[i].isDefault)) return tracks[i];
    for (let i = 0; i < tracks.length; i++) if (usableTrack(tracks[i])) return tracks[i];
    return null;
}

// The track in the viewer's subtitle language (Auto-Translate Subtitles), or
// null: the same language and the same pick as Subtitles When a Video Starts
// (currentTarget, pickTrack), so both turn on the same one: its own words,
// else speech recognition, else the auto-translated copy subtitle-translate.js
// adds to a video with no track in that language.
function preferredCaptionTrack(tracks) {
    const lang = currentTarget();
    return lang ? pickTrack(tracks, lang) : null;
}

function toggleSubtitlesLogic(player) {
    let toggledViaApi = false;
    if (player) {
        // Try API first
        if (typeof player.loadModule === 'function') player.loadModule('captions');
        if (typeof player.getOption === 'function' && typeof player.setOption === 'function') {
          try {
            const currentTrack = player.getOption('captions', 'track');
            // The player's own track objects name it vss_id, ours vssId.
            const isOn = (track) => !!track && !!(track.languageCode || track.vssId || track.vss_id);
            if (isOn(currentTrack)) { player.setOption('captions', 'track', {}); showNotification('Subtitles: OFF'); toggledViaApi = true; }
            else {
              const list = player.getOption('captions', 'tracklist');
              const tracks = captionTracks(player, list);
              const switchOn = (track) => {
                player.setOption('captions', 'track', track);
                showNotification(subtitlesOnNotice(track));
                toggledViaApi = true;
              };
              // The viewer's subtitle language, when one is set.
              // Also among the video's own tracks, before the player's choice:
              // the list can lack the one in that language.
              const preferred = preferredCaptionTrack(tracks) || preferredCaptionTrack(videoCaptionTracks(player));
              if (preferred) switchOn(preferred);
              // Else the player's own choice, as its captions button makes it:
              // the viewer's last language, else the video's (English on that
              // TED talk, webOS 25). It only switches on, and has set the track
              // when it returns (measured on the TV).
              if (!toggledViaApi && typeof player.toggleSubtitlesOn === 'function') {
                // A player still starting can throw here: the track is read
                // again (it may have been set), else the list below is tried.
                try { player.toggleSubtitlesOn(); } catch { /* not ready */ }
                const chosen = player.getOption('captions', 'track');
                if (isOn(chosen)) {
                  showNotification(subtitlesOnNotice(chosen));
                  toggledViaApi = true;
                }
              }
              // Else from the tracks (captionTracks already gave the video's
              // own when the list had none to use).
              if (!toggledViaApi) {
                const target = pickCaptionTrack(tracks);
                if (target) switchOn(target);
              }
            }
          } catch (e) { console.warn('[Shortcut] Subtitle API Error:', e); }
        }
    }
    // Fallback to UI clicking
    if (!toggledViaApi) {
        const capsBtn = document.querySelector('ytlr-captions-button yt-button-container') || document.querySelector('ytlr-captions-button ytlr-button');
        if (capsBtn) {
          if (triggerInternal(capsBtn, 'Captions')) {
            setTimeout(() => {
              const isPressed = capsBtn.getAttribute('aria-pressed') === 'true';
              showNotification(isPressed ? 'Subtitles: ON' : 'Subtitles: OFF');
            }, 250);
            return;
          }
        }
        showNotification('Subtitles unavailable');
    }
}

function toggleCommentsLogic() {
    const target = findPlayerButton(isCommentsButton) || resolveCached('comments', COMMENT_SELECTORS);
    let commBtn = target ? target.closest('yt-button-container, ytlr-button') : null;
    let isLiveChat = false;

    if (!commBtn) {
          const chatTarget = document.querySelector('ytlr-live-chat-toggle-button yt-button-container, yt-button-container[aria-label="Live chat"]');
          if (chatTarget) {
              commBtn = chatTarget;
              isLiveChat = true;
          }
    }

    const isBtnActive = commBtn && (commBtn.getAttribute('aria-pressed') === 'true' || commBtn.getAttribute('aria-selected') === 'true');
    const isPanelVisible = isEngagementPanelVisible();

    if ((isBtnActive || isPanelVisible) && !isLiveChat) simulateBack();
    else if (triggerInternal(commBtn, isLiveChat ? 'Live Chat' : 'Comments')) {
            if (isLiveChat) {
                setTimeout(() => {
                    const pressed = commBtn.getAttribute('aria-pressed') === 'true';
                    showNotification(pressed ? 'Live Chat: ON' : 'Live Chat: OFF');
                }, 250);
            }
        }
        else {
            showNotification(isLiveChat ? 'Live Chat Unavailable' : 'Comments Unavailable');
        }
}

// Open Comments at the End of a Video. With autoplay on, opening the panel
// stops the countdown to the next video for good (webOS 25), so it opens only
// with autoplay off. Not when the viewer pressed a key just before the end
// (leaving, most likely), and once a video: closed, it stays closed.
const END_KEY_WINDOW_MS = 3000;
const END_OPEN_DELAY_MS = 1000;
const END_COMMENT_SELECTORS = 'yt-button-container[aria-label="Comments"], ' +
    '[idomkey="TRANSPORT_CONTROLS_BUTTON_TYPE_COMMENTS"] ytlr-button';
let lastViewerKeyAt = 0;
let commentsOpenedFor = null;
let endTimer = null;
window.addEventListener('keydown', (evt) => {
    if (!evt[SYNTHETIC_KEY_FLAG]) lastViewerKeyAt = Date.now();
}, true);
window.addEventListener('yt-player-state-change', ({ detail }) => {
    if (!detail) return;
    const videoId = detail.videoId;
    if (detail.state !== 0) {
        // Left the end within the delay (replayed, or the next video): not
        // opened over a video that plays. Any state counts: replayed with the
        // pointer on the TV it went -1, 5, 3, and played only after the delay.
        clearTimeout(endTimer);
        endTimer = null;
    }
    if (detail.state === 1 && videoId !== commentsOpenedFor) commentsOpenedFor = null;
    if (detail.state !== 0 || !configRead('openCommentsAtEnd') || !videoId) return;
    const endedAt = Date.now();
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
        endTimer = null;
        // Read again: switched off with the pointer during the delay, no key counted.
        if (!configRead('openCommentsAtEnd') || lastViewerKeyAt > endedAt - END_KEY_WINDOW_MS) return;
        if (!isWatchPage() || isShortsPage() || !window.location.hash.includes(videoId)) return;
        if (commentsOpenedFor === videoId || isEngagementPanelVisible() || isAutoplayOn()) return;
        // No button (comments turned off, or none): nothing, and no toast.
        // Pressed with no key, so only a button known to be the comments one:
        // the positional selectors of COMMENT_SELECTORS (and one cached by the
        // Toggle Comments key) could hit another button there, a dislike say.
        const target = findPlayerButton((d) => isCommentsButton(d) && !d.isDisabled) ||
            document.querySelector(END_COMMENT_SELECTORS);
        const button = target && target.closest('yt-button-container, ytlr-button');
        if (!button) return;
        commentsOpenedFor = videoId;
        triggerInternal(button, 'Comments at the end');
    }, END_OPEN_DELAY_MS);
});

function toggleDescriptionLogic() {
    let target = findPlayerButton(isDescriptionButton);

    if (!target && cachedSelectors.description) {
        const cachedEl = document.querySelector(cachedSelectors.description);
        target = cachedEl ? cachedEl.closest('yt-button-container') : null;
    }

    // Text-matching pass can't be expressed as a selector, so it stays bespoke.
    // The querySelectorAll result is iterated directly rather than materialised
    // into an array first.
    if (!target) {
        const candidates = document.querySelectorAll('yt-formatted-string.XGffTd.OqGroe');
        for (let i = 0; i < candidates.length; i++) {
            if (candidates[i].textContent.trim() === 'Description') {
                target = candidates[i].closest('yt-button-container');
                break;
            }
        }
    }

    if (!target) {
        const genericTextBtn = document.querySelector(DESCRIPTION_FALLBACK_SELECTOR);
        if (genericTextBtn) {
            target = genericTextBtn.closest('yt-button-container');
            cachedSelectors.description = DESCRIPTION_FALLBACK_SELECTOR;
        }
    }

    const isDescActive = target && (target.getAttribute('aria-pressed') === 'true' || target.getAttribute('aria-selected') === 'true');
    const isPanelVisible = isEngagementPanelVisible();

    if (isDescActive || isPanelVisible) simulateBack();
    else if (triggerInternal(target, 'Description')) {
            setTimeout(() => {
                if (window.returnYouTubeDislike) {
                    console.log('[Shortcut] Manually triggering RYD check for description panel...');
                    window.returnYouTubeDislike.observeBodyForPanel();
                }
            }, 350);
        }
        else showNotification('Description Unavailable');
}

function saveToPlaylistLogic() {
    const el = findPlayerButton(isSaveButton) || resolveCached('save', SAVE_SELECTORS);
    // Structural check rather than comparing against the selector string, so
    // this keeps working if the selector text ever changes.
    const target = el && el.tagName === 'YT-ICON' ? el.closest('yt-button-container') : el;

    const panel = document.querySelector('.AmQJbe');
      
    if (panel) simulateBack();
    else if (!triggerInternal(target, 'Save/Watch Later')) {
            showNotification('Save Button Unavailable');
        }
}

function refreshPageLogic() {
    const commandPayload = {
        clickTrackingParams: '',
        signalServiceEndpoint: {
            signal: 'CLIENT_SIGNAL',
            actions: [
                {
                    clickTrackingParams: '',
                    signalAction: {
                        signal: 'SOFT_RELOAD_PAGE'
                    },
                    commandMetadata: {
                        webCommandMetadata: {
                            clientAction: true
                        }
                    }
                }
            ]
        }
    };

    const appRoot = document.querySelector('ytlr-app') || document.body;
    console.log('[Shortcut] Triggering soft reload...');
    
    appRoot.dispatchEvent(new CustomEvent('innertube-command', {
        bubbles: true,
        cancelable: false,
        composed: true,
        detail: commandPayload
    }));
    
    // showNotification('Refreshing Page...');
}

function playPauseLogic(video) {
    const notify = (msg) => {
        if (activePlayPauseNotification) {
            activePlayPauseNotification.update(msg);
        } else {
            activePlayPauseNotification = showNotification(msg);
        }
        
        if (playPauseNotificationTimer) clearTimeout(playPauseNotificationTimer);
        playPauseNotificationTimer = setTimeout(() => {
            activePlayPauseNotification = null;
            playPauseNotificationTimer = null;
        }, 3000);
    };

    if (video.paused) { 
        video.play(); 
        notify('Playing');
    } else {
        video.pause();
        notify('Paused');
        
        const controls = document.querySelector('yt-focus-container[idomkey="controls"]');
        const isControlsVisible = controls && controls.classList.contains('zylon-focus');
        
        // Only run hiding logic if the controls are not already visible
        if (!isControlsVisible) {
            const watchOverlay = document.querySelector('.webOs-watch');
            
            document.body.classList.add('ytaf-hide-controls');
            if (watchOverlay) watchOverlay.style.opacity = '0';
            
            // We only process the dismissal timers if we aren't on a Shorts page
            if (!isShortsPage()) {
                
                // Lazy-check the engagement panel visibility
                if (!isEngagementPanelVisible()) {
                    shortcutDebounceTime = 650;
                
                    if (document.activeElement && typeof document.activeElement.blur === 'function') {
                        document.activeElement.blur();
                    }
                    
                    setTimeout(() => {
                        const currentControls = document.querySelector('yt-focus-container[idomkey="controls"]');
                        if (currentControls && currentControls.classList.contains('zylon-focus')) {
                            sendKey(REMOTE_KEYS.BACK, document.activeElement);
                        }
                    }, 250);
                }
            }

            // Cleanup CSS and overlay (on Shorts too, or the controls and the
            // clock stay hidden after leaving them)
            setTimeout(() => {
              document.body.classList.remove('ytaf-hide-controls');
              if (watchOverlay) watchOverlay.style.opacity = '';
            }, 750);
        }
    }
}

// --- Jump to Live ---
// On a live stream that was paused or rewound, back to the live edge
// (NicholasBly/youtube-webos#148). The player's own seekToLiveHead keeps its
// live state right; the <video>'s seekable range is the fallback.
function jumpToLiveLogic(video) {
    const player = document.getElementById(SELECTORS.PLAYER_ID);
    if (!isLiveStream(player, video)) {
        showNotification('Not a live stream');
        return;
    }
    try {
        if (player && typeof player.seekToLiveHead === 'function') {
            player.seekToLiveHead();
        } else {
            const ranges = video.seekable;
            if (!ranges || !ranges.length) { showNotification('Live edge not available'); return; }
            video.currentTime = Math.max(0, ranges.end(ranges.length - 1) - 1);
        }
        if (video.paused) video.play();
        showNotification('Jumped to Live');
    } catch (e) {
        console.warn('[Shortcut] Jump to live failed:', e);
        showNotification('Live edge not available');
    }
}

// --- Sleep Timer ---
// Each press steps to the next duration; past the last one it switches off.
// When it runs out the video is paused, so the TV's own idle timer and
// screensaver take over as if the viewer had stopped watching.
const SLEEP_TIMER_STEPS_MIN = [15, 30, 60, 90, 120];
let sleepTimerStep = -1;
let sleepTimerId = null;

function clearSleepTimer() {
    if (sleepTimerId) { clearTimeout(sleepTimerId); sleepTimerId = null; }
    sleepTimerStep = -1;
}

function cycleSleepTimer() {
    const next = sleepTimerStep + 1;
    clearSleepTimer();
    if (next >= SLEEP_TIMER_STEPS_MIN.length) {
        showNotification('Sleep timer off');
        return;
    }
    sleepTimerStep = next;
    const minutes = SLEEP_TIMER_STEPS_MIN[next];
    sleepTimerId = setTimeout(() => {
        clearSleepTimer();
        const video = getVideo();
        if (video && !video.paused) video.pause();
        showNotification('Sleep timer: playback paused');
    }, minutes * 60000);
    showNotification(`Sleep timer: ${minutes} min`);
}

function handleShortcutAction(action) {
  // Global Actions - Do not require Video
  if (action === 'config_menu') {
      showOptionsPanel(!optionsPanelVisible);
      return;
  }
  
  if (action === 'oled_toggle') {
      if (endOledBlackout()) {
          showNotification('OLED Black Overlay Off');
      } else {
          // Below the notification container (1200) so the toasts - this
          // feature's own included - are not painted behind the blackout, and
          // above the settings panel (1000). The clock (1199) is hidden by the
          // class instead, so it does not burn in on a black screen.
          const overlay = createElement('div', { id: 'oled-black-overlay', style: { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: '#000', zIndex: 1100 }});
          document.body.appendChild(overlay);
          document.documentElement.classList.add('ytaf-oled-blackout');
          
          // Keep TV awake by simulating input
          oledKeepAliveTimer = setInterval(() => {
            sendKey(REMOTE_KEYS.UP);
            setTimeout(() => sendKey(REMOTE_KEYS.UP), 250);
          }, 30 * 60 * 1000);
          showNotification('OLED Black Overlay On');
      }
      return;
  }
  if (action === 'sleep_timer') {
      cycleSleepTimer();
      return;
  }
  if (action === 'queue_clear') {
      clearQueue();
      return;
  }
  if (action === 'queue_next') {
      playNextInQueue();
      return;
  }
  if (action === 'long_press_menu') {
      openFocusedLongPressMenu();
      return;
  }
  if (action === 'refresh_page') {
      if (isWatchPage() || isShortsPage()) {
          showNotification('Cannot refresh on player pages');
          return;
      }
      refreshPageLogic();
      return;
  }

  // Player Actions - Require Video/Context
  // Player actions only make sense on a watch or Shorts page.
  if (!isWatchPage() && !isShortsPage()) return;

  // Before the <video> is asked for: on Shorts it may not be there yet, and
  // the key still says there is no video to repeat. One message, updated, so
  // On and Off are not both on the screen after two quick presses.
  if (action === 'repeat_video') {
      const msg = toggleRepeat();
      // Notifications off: none is shown, and none kept (it would be a no-op).
      if (configRead('disableNotifications')) return;
      if (repeatNotification) repeatNotification.update(msg);
      else repeatNotification = showNotification(msg);
      return;
  }

  const video = getVideo();
  if (!video) return;

  switch (action) {
    case 'chapter_skip':
        skipChapter('next');
        break;
    case 'chapter_skip_prev':
        skipChapter('prev');
        break;
    case 'seek_15_fwd':
        performBurstSeek(5, video);
        break;
    case 'seek_15_back':
        performBurstSeek(-5, video);
        break;
    case 'play_pause':
        playPauseLogic(video);
        break;
    case 'jump_to_live':
        jumpToLiveLogic(video);
        break;

    case 'speed_up':
        stepSpeed(1);
        break;

    case 'speed_down':
        stepSpeed(-1);
        break;

    case 'speed_reset':
        resetSpeed();
        break;

    case 'speed_toggle':
        toggleSpeed();
        break;

    case 'sb_whitelist_channel':
        toggleChannelWhitelist();
        break;
    case 'toggle_subs':
        // Resolved here rather than above the switch: only this one action
        // needs it, and the .html5-video-player fallback is a full-document
        // class-selector walk that was being paid on every shortcut keypress.
        toggleSubtitlesLogic(
            document.getElementById(SELECTORS.PLAYER_ID) || document.querySelector('.html5-video-player')
        );
        break;
    case 'toggle_comments':
        toggleCommentsLogic();
        break;
    case 'toggle_description':
        toggleDescriptionLogic();
        break;
    case 'save_to_playlist':
        saveToPlaylistLogic();
        break;
    case 'sb_skip_prev':
        if (window.sponsorblock) {
            const success = window.sponsorblock.skipToPreviousSegment();
            if (!success) showNotification('No previous segment found');
        } else {
            showNotification('SponsorBlock not loaded');
        }
        break;
    case 'audio_only':
        toggleAudioOnly();
        break;
    case 'sb_manual_skip':
        try {
          if (window.sponsorblock) {
            const handled = window.sponsorblock.handleBlueButton(); // Keep naming convention even if not blue button
            if (!handled) showNotification('No action available');
          } else showNotification('SponsorBlock not loaded');
        } catch (e) { showNotification('Error: ' + e.message); }
        break;
    default:
        console.warn(`[Shortcut] Unknown action: ${action}`);
  }
}

// --- Global Input Handler ---

// Whether `el` takes typed text: a textarea, or an input other than a checkbox
// or a colour. A digit with one of the panel's checkboxes focused is still a
// shortcut (a digit bound to the menu must close the panel from there too).
function isTextBox(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'color';
}

const isSyntheticKey = (evt) => !!evt[SYNTHETIC_KEY_FLAG] || evt.isTrusted === false || isSyntheticKeyEcho(evt);

// The key that closed the settings panel (Back, Escape, an Enter, the menu
// key) is swallowed until it is released: a held Back keeps repeating, and
// once the panel's own handler is gone the repeats would reach YouTube as a
// page back. heldKeyCode is the trusted key currently down, so
// showOptionsPanel(false) knows which one closed it. Keys this mod sends
// itself pass (play/pause sends Back).
let heldKeyCode = null;
let swallowedKeyCode = null;
let swallowTimer = null;

function releaseSwallowedKey() {
  swallowedKeyCode = null;
  if (swallowTimer) { clearTimeout(swallowTimer); swallowTimer = null; }
}

function armSwallowTimer(ms) {
  if (swallowTimer) clearTimeout(swallowTimer);
  // A keyup the TV never delivers must not hold the key for good.
  swallowTimer = setTimeout(releaseSwallowedKey, ms);
}

function swallowHeldKey() {
  if (heldKeyCode === null) return;
  swallowedKeyCode = heldKeyCode;
  armSwallowTimer(2000);
}

window.addEventListener('keydown', (evt) => {
  if (isSyntheticKey(evt)) return;
  const code = evt.keyCode;
  if (swallowedKeyCode !== null && code === swallowedKeyCode) {
    // A held key keeps sliding the window; its keyup ends it.
    if (evt.repeat) armSwallowTimer(1000);
    evt.preventDefault();
    evt.stopImmediatePropagation();
    return;
  }
  heldKeyCode = code;
}, true);

window.addEventListener('keyup', (evt) => {
  if (isSyntheticKey(evt)) return;
  if (evt.keyCode === heldKeyCode) heldKeyCode = null;
  if (swallowedKeyCode !== null && evt.keyCode === swallowedKeyCode) {
    releaseSwallowedKey();
    evt.preventDefault();
    evt.stopImmediatePropagation();
  }
}, true);

const eventHandler = (evt) => {
  // Keys this mod synthesises (screensaver keep-alive sends Yellow, play/pause
  // sends Back) must never trigger a binding.
  if (isSyntheticKey(evt)) return true;

  const code = evt.keyCode || evt.charCode;
  const keyColor = getKeyColor(code);

  // FAST FAIL: If typing in a native text box, let standard characters (like 0-9) pass through instantly
  if (!keyColor && isTextBox(evt.target)) {
      return true;
  }

  // Identify Key (Name)
  let keyName = keyColor;
  const isNumberKey = evt.type === 'keydown' && evt.keyCode >= 48 && evt.keyCode <= 57;

  if (isNumberKey) {
      if (isSearchPage()) return true;
      keyName = String(evt.keyCode - 48);
  }

  if (!keyName) return true; // Not a managed key

  // Get Action
  const action = shortcutCache[keyName];
  if (!action || action === 'none') return true;

  // Scope & Context Checking (O(1) Efficiency)
  const isVideoPage = isWatchPage() || isShortsPage();
  const actionScope = ACTION_SCOPES[action] || 'VIDEO'; // Default unknown actions to VIDEO for safety

  // Release the key instantly if the action's required scope doesn't match the page
  if (actionScope === 'VIDEO' && !isVideoPage) return true;

  // --- Proceed to Debounce and Execution ---

  const isBurstAction = action === 'seek_15_fwd' || action === 'seek_15_back';

  // A held bound key: its repeats are one press and never reach YouTube (a
  // held digit would jump the video to a percentage). The seeks batch their
  // presses, repeats included, so a held seek key keeps seeking.
  if (evt.repeat && !isBurstAction) {
      evt.preventDefault();
      evt.stopPropagation();
      return false;
  }

  const now = Date.now();

  const dedupeWindow = isBurstAction ? BURST_DUPLICATE_MS : shortcutDebounceTime;

  if (now - lastShortcutTime < dedupeWindow && lastShortcutKey === keyName) {
      evt.preventDefault();
      evt.stopPropagation();
      return false;
  }

  if (optionsPanelVisible && action !== 'config_menu') { evt.preventDefault(); evt.stopPropagation(); return false; }

  shortcutDebounceTime = 100;
  lastShortcutTime = now;
  lastShortcutKey = keyName;

  evt.preventDefault();
  evt.stopPropagation();
  handleShortcutAction(action);

  return false;
};

// window, not document, and in the capture phase. YouTube's own key handler
// sits on window capture and calls stopPropagation for the colour keys it
// claims - yellow routes to search - so a document-capture listener never saw
// a trusted yellow keydown at all. The userScript runs before YouTube's app
// code, so registering here first resolves our binding before theirs. Keys
// with no binding return without preventDefault and propagate as before.
window.addEventListener('keydown', eventHandler, true);

// --- Initialization & CSS Injection ---

function initGlobalStyles() {
    // Static stylesheet — written once, never rebuilt. Toggling a class on the
    // <html> element activates/deactivates each section. We use documentElement
    // rather than body because YouTube's leanback app rewrites body.className
    // on tab navigation (Home → Gaming, etc.) and would wipe our toggles.
    // .ytaf-hide-controls stays on body because it's owned by play/pause logic,
    // not config — YouTube never touches it.
    const style = createElement('style');
    style.textContent = `
        html.ytaf-oled-blackout .webOs-watch { display: none !important; }
        html.ytaf-audio-only video { visibility: hidden !important; }

        html.ytaf-hide-logo ytlr-redux-connect-ytlr-logo-entity,
        html.ytaf-hide-logo ytlr-logo-entity { visibility: hidden !important; }

        body.ytaf-hide-controls .GLc3cc,
        body.ytaf-hide-controls .webOs-watch,
        body.ytaf-hide-controls .ytLrWatchDefaultShadow,
        body.ytaf-hide-controls [idomkey='shadow'],
        body.ytaf-hide-controls .ytLrWatchDefault2025Shadow { opacity: 0 !important; }

        /* OLED-care mode — written once, toggled by html.oled-theme-active.
           Gated on <html> rather than <body> because YouTube's leanback app
           rewrites body.className on tab navigation and panel dialogs, which
           would wipe a body-class gate and silently disable these rules.
           Same reason ytaf-hide-logo / ytaf-remove-borders
           already live on documentElement.

           The shelf backdrop's opacity is a rule of its own in
           <style id="ytaf-oled-opacity"> (syncOledShelfOpacity), so a
           videoShelfOpacity slider tick never rebuilds this block; the
           conditional rules sit under html.oled-transparent-shelf. */
        html.oled-theme-active #container,
        html.oled-theme-active .ytLrGuideResponseMask,
        html.oled-theme-active .geClSe,
        html.oled-theme-active .hsdF6b,
        html.oled-theme-active .ytLrAnimatedOverlayContainer,
        html.oled-theme-active .ZghAqf,
        html.oled-theme-active .RAE3Re .AmQJbe,
        html.oled-theme-active .tVp1L,
        html.oled-theme-active .DnwJH,
        html.oled-theme-active .qRdzpd.stQChb .TYE3Ed,
        html.oled-theme-active .k82tDb { background-color: #000 !important; }
        html.oled-theme-active .ytLrGuideResponseGradient { display: none; }
        html.oled-theme-active .iha0pc { color: #000 !important; }
        html.oled-theme-active .p0DeOc { background-color: #000 !important; background-image: none !important; }
        html.oled-theme-active ytlr-player-focus-ring { border: 0.375rem solid rgb(200, 200, 200) !important; }
        html.oled-theme-active ytlr-surface-page { background-image: none !important; background-color: #000 !important; }
        html.oled-theme-active.oled-transparent-shelf .UGcxnc .dxLAmd,
        html.oled-theme-active.oled-transparent-shelf .UGcxnc .Dc2Zic .JkDfAc { background-color: rgba(0, 0, 0, 0) !important; }

        /* The .app-quality-root rules below restyle YouTube's low-memory
           black boxes. With Remove Black Text Boxes on (app-quality-fix.js)
           the class is off <body> and the boxes are gone, so they apply only
           with it off. */
        /* Titles over more than one line: less space around each line in
           those boxes. Always on, no setting (it was Fix Multiline Titles). */
        .app-quality-root .SK1srf .WVWtef,
        .app-quality-root .SK1srf .niS3yd {
            padding-bottom: 0.37vh !important;
            padding-top: 0.37vh !important;
        }

        /* Search results font: YouTube TV's CSS gives the search page's video
           titles (.prqC5c) Roboto, every other page the TV's own font. Always
           on, no setting: off an LG TV the font is missing and Roboto stays.
           (From NicholasBly 0.8.5.) */
        body.WEB_PAGE_TYPE_SEARCH .prqC5c {
            font-family: 'LG Display-Regular', 'LG Display', Roboto, 'Noto Sans CJK ZH-HK', 'Noto Sans Thai', Arial,
                Helvetica, sans-serif !important;
        }

        html.ytaf-remove-borders yt-formatted-string,
        html.ytaf-remove-borders .style-scope.ytd-rich-grid-media,
        html.ytaf-remove-borders #video-title,
        html.ytaf-remove-borders #metadata-line,
        html.ytaf-remove-borders .ytd-video-meta-block {
            background-color: transparent !important;
            background: none !important;
            box-shadow: none !important;
        }
        html.ytaf-remove-borders #details.ytd-rich-grid-media {
            background-color: transparent !important;
            margin-top: 4px !important;
        }
        html.ytaf-remove-borders ytd-thumbnail,
        html.ytaf-remove-borders .ytd-searchbox,
        html.ytaf-remove-borders .ytp-videowall-still-info-bg {
            background-color: transparent !important;
        }
        html.ytaf-remove-borders .app-quality-root .boSXqb .QFqCxd:before,
        html.ytaf-remove-borders .app-quality-root .V7jTHe,
        html.ytaf-remove-borders .app-quality-root .g6XRz,
        html.ytaf-remove-borders .app-quality-root .UGcxnc .sjENQb {
            background-color: transparent !important;
        }
        html.ytaf-remove-borders .ltewod.BZ345e { background-color: #f1f1f1 !important; }
        /* The player's left (channel, description, subscribe) and middle (previous,
           next) buttons: YouTube draws them itself, solid in memory saving and
           faintly white without it. A focused one turns into .lu66D.zylon-focus,
           its white highlight, and is left alone. (#158) */
        html.ytaf-remove-borders ytlr-player-actions-container yt-button-container.CgA6bd.UMztjd:not(.zylon-focus),
        html.ytaf-remove-borders .MIiKQd.CgA6bd,
        html.ytaf-remove-borders .clJQEe,
        html.ytaf-remove-borders .dySudf,
        html.ytaf-remove-borders .ltewod {
            background-color: rgba(45, 45, 45, 0.45) !important;
            background-image: linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0) 100%) !important;
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3) !important;
        }

        body .ytLrWatchDefaultShadow,
        body [idomkey='shadow'] {
            display: block !important;
            height: 100% !important;
            width: 100% !important;
            pointer-events: none !important;
            position: absolute !important;
            background-image: linear-gradient(to bottom, rgba(0, 0, 0, 0) 0, rgba(0, 0, 0, 0.8) 90%) !important;
            background-color: rgba(0, 0, 0, 0.3) !important;
        }
        body .ytLrWatchDefault2025Shadow { background-color: rgba(11, 11, 11, 0.5) !important; }

        /* Disable Animations. Scoped to YouTube's own app root, so the settings
           panel, notifications and the clock (all on <body>) keep theirs.
           Near-zero durations rather than "none": a transitionend or
           animationend that YouTube waits for still fires, just at once.
           Chrome 38 (webOS 3) only knows the -webkit- animation properties. */
        html.ytaf-no-animations ytlr-app,
        html.ytaf-no-animations ytlr-app *,
        html.ytaf-no-animations ytlr-app *:before,
        html.ytaf-no-animations ytlr-app *:after {
            -webkit-transition-duration: 0.01ms !important;
            transition-duration: 0.01ms !important;
            -webkit-transition-delay: 0s !important;
            transition-delay: 0s !important;
            -webkit-animation-duration: 0.01ms !important;
            animation-duration: 0.01ms !important;
            -webkit-animation-delay: 0s !important;
            animation-delay: 0s !important;
            -webkit-animation-iteration-count: 1 !important;
            animation-iteration-count: 1 !important;
            scroll-behavior: auto !important;
        }

        /* Not display:none: YouTube still focuses it at start, and a hidden element
           cannot take focus, which would leave focus nowhere. */
        html.ytaf-hide-guest-nudge ytlr-feed-nudge-renderer { opacity: 0 !important; height: 0 !important; overflow: hidden !important; }

        /* Hide Recommended Videos (adblock.js): with the rows gone the pivot
           under the player keeps its grey skeleton tiles up for good. */
        html.ytaf-hide-recommended ytlr-pivot ytlr-ghost-surface { display: none !important; }
    `;
    document.head.appendChild(style);

    const syncClass = (cls, key) => document.documentElement.classList.toggle(cls, !!configRead(key));
    const CLASS_KEYS = {
        'ytaf-remove-borders': 'removeBlackBorders',
        'ytaf-no-animations': 'disableAnimations',
        'ytaf-hide-recommended': 'hideRecommendedVideos'
    };
    for (const [cls, key] of Object.entries(CLASS_KEYS)) {
        syncClass(cls, key);
        configAddChangeListener(key, () => syncClass(cls, key));
    }

    // Guest mode, Hide Sign-in Buttons: the guest home's sign-in nudge comes in
    // the session's first response, which YouTube parses before the JSON.parse
    // hook (adblock.js) is in, so it is hidden here as well. Focus landing on
    // the hidden nudge is passed to the guide.
    const passFocus = (el) => {
        if (el && el.closest && el.closest('ytlr-feed-nudge-renderer')) sendKey(REMOTE_KEYS.LEFT, el);
    };
    const syncGuestNudge = () => {
        invalidateGuestModeCache();
        const on = isGuestMode() && !!configRead('enableAdBlock') && !!configRead('hideGuestSignInPrompts');
        if (on) passFocus(document.activeElement);
        document.documentElement.classList.toggle('ytaf-hide-guest-nudge', on);
    };
    syncGuestNudge();
    configAddChangeListener('hideGuestSignInPrompts', syncGuestNudge);
    configAddChangeListener('enableAdBlock', syncGuestNudge);
    window.addEventListener('ytaf-page-update', syncGuestNudge);
    document.addEventListener('focusin', (evt) => {
        if (document.documentElement.classList.contains('ytaf-hide-guest-nudge')) passFocus(evt.target);
    }, true);
}

const LOGO_URLS = {
  'logo-orange': logoOrangeUrl,
  'logo-blue': logoBlueUrl,
  'logo-red': logoRedUrl,
  'logo-dark': logoDarkUrl
};

/** The logo variant for the current theme: one of the LOGO_URLS keys. */
function currentLogoVariant() {
  const theme = configRead('uiTheme');
  return configRead('enableOledCareMode') ? 'logo-dark'
    : theme === 'classic-red' ? 'logo-red'
    : theme === 'fox' ? 'logo-orange'
    : 'logo-blue';
}

function updateLogoState() {
  const wanted = currentLogoVariant();
  document.querySelectorAll('.ytaf-logo').forEach((logo) => {
    logo.style.display = logo.classList.contains(wanted) ? '' : 'none';
  });
  syncPointerButtonTheme();
}

// The shelf backdrop's opacity, written as a rule of its own rather than a CSS
// custom property: Chromium 38 (webOS 3) has no var() and dropped the whole
// declaration, leaving the shelf un-blacked. From mirijanristic's fork.
function syncOledShelfOpacity() {
  const opacityVal = configRead('videoShelfOpacity');
  let style = document.getElementById('ytaf-oled-opacity');
  if (!style) {
    style = document.createElement('style');
    style.id = 'ytaf-oled-opacity';
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = `html.oled-theme-active .Jx9xPc { background-color: rgba(0, 0, 0, ${opacityVal / 100}) !important; }`;
  document.documentElement.classList.toggle('oled-transparent-shelf', opacityVal > 50);
}

function applyOledMode(enabled) {
  // All the OLED rules now live in initGlobalStyles() as static CSS gated by
  // html.oled-theme-active. We toggle on documentElement (not body) because
  // YouTube rewrites body.className on navigation/panel transitions — a body
  // gate would silently drop OLED whenever YT touched the class string.
  if (optionsPanel) optionsPanel.classList.toggle('oled-care', enabled);
  setNotificationOled(enabled);

  document.documentElement.classList.toggle('oled-theme-active', !!enabled);
  if (enabled) syncOledShelfOpacity();
  else document.documentElement.classList.remove('oled-transparent-shelf');

  updateLogoState();
}

function applyTheme(theme) {
  if (optionsPanel) {
      optionsPanel.classList.toggle('theme-classic-red', theme === 'classic-red');
      optionsPanel.classList.toggle('theme-fox', theme === 'fox');
  }
  setNotificationTheme(theme);
  updateLogoState();
}

// The key that opens the settings panel. With none bound (the viewer gave the
// menu key another action), Green opens it again; `announce` says so in a
// toast. Runs at start and whenever the panel closes, so a binding changed in
// the panel takes effect without a restart.
function ensureMenuKey(announce) {
    const key = shortcutKeys.find(k => shortcutCache[k] === 'config_menu');
    if (key) return key;
    console.warn('[UI] No menu keybind found. Forcing Green button to Open Settings.');
    configWrite('shortcut_key_green', 'config_menu');
    if (announce) showNotification('Press [GREEN] to open the settings');
    return 'green';
}

const startupMenuKey = ensureMenuKey(false);

// --- Start-up ---
initGlobalStyles();
initVideoQuality();
initLogoStyle();
initMathLetters();
initPlaybackSpeed();

// Initial apply (will skip UI elements if they don't exist yet, but handle global styles)
applyOledMode(configRead('enableOledCareMode'));
configAddChangeListener('enableOledCareMode', (evt) => applyOledMode(evt.detail.newValue));

// The Fox theme is this fork's default. An install that already stored the
// old default (blue) is moved to it once; after that the choice is the
// viewer's.
if (!configRead('foxThemeApplied')) {
  configWrite('foxThemeApplied', true);
  if (configRead('uiTheme') === 'blue-force-field') configWrite('uiTheme', 'fox');
}

applyTheme(configRead('uiTheme'));
configAddChangeListener('uiTheme', (evt) => applyTheme(evt.detail.newValue));

// Tracking Block is gated on Ad Blocking, so its network hooks follow it.
configAddChangeListener('enableAdBlock', () => syncTrackingBlock());

function syncTrackingBlock() {
  // Greyed out in the panel while Ad Blocking is off, so off then as well.
  if (configRead('enableAdBlock') && configRead('enableTrackingBlock')) initTrackingBlock();
  else destroyTrackingBlock();
}

configAddChangeListener('enableTrackingBlock', syncTrackingBlock);

configAddChangeListener('videoShelfOpacity', () => {
  // Cheap update — rewrites the one-rule opacity <style> and toggles the
  // transparent-shelf class. No rebuild of the global stylesheet.
  if (configRead('enableOledCareMode')) syncOledShelfOpacity();
});

// --- UI Brightness ---
//
// A dark layer over the browse UI (home, search, channels...), never over the
// watch page or Shorts, so the video itself is not dimmed. It lets every
// pointer event through, and it sits under the settings panel, notifications,
// the clock and the pointer button (ui.css), so only YouTube's own UI dims.
let dimOverlay = null;
function syncUiBrightness() {
  const brightness = Number(configRead('uiBrightness')) || 100;
  const on = brightness < 100 && !isWatchPage() && !isShortsPage();
  if (!on) {
    if (dimOverlay) dimOverlay.style.display = 'none';
    return;
  }
  if (!dimOverlay) {
    if (!document.body) return;
    dimOverlay = createElement('div', { id: 'ytaf-dim-overlay' });
    document.body.appendChild(dimOverlay);
  }
  dimOverlay.style.opacity = String((100 - Math.max(0, brightness)) / 100);
  dimOverlay.style.display = 'block';
}
configAddChangeListener('uiBrightness', syncUiBrightness);
window.addEventListener('ytaf-page-update', syncUiBrightness);

// --- Settings button for the Magic Remote pointer ---
//
// Remotes with no colour buttons (the LG MR26, NicholasBly/youtube-webos#189)
// had no way into the panel. A fox button in the top-right corner (the logo
// and colours of the current theme, see syncPointerButtonTheme) shows while
// the pointer is in use - on a real move, never on its own - and fades a few
// seconds after the last one, or as soon as webOS hides the pointer. A click
// opens or closes the panel. It is a plain <div> with no tabindex (tabIndex
// -1) and takes no focus on click, so neither D-pad navigation nor YouTube's
// focus model can ever land on it.
const POINTER_BUTTON_HIDE_MS = 4000;
let pointerButtonTimer = 0;
let lastPointerX = -1;
let lastPointerY = -1;

function hidePointerButton() {
  clearTimeout(pointerButtonTimer);
  if (pointerButton) pointerButton.classList.remove('ytaf-visible');
}

function createPointerButton() {
  const swallow = (evt) => { evt.preventDefault(); evt.stopPropagation(); };
  const btn = createElement('div', {
    id: 'ytaf-pointer-btn',
    title: 'YouTube Foxtended settings',
    events: {
      // preventDefault keeps focus where it is (no blur of the panel's row).
      mousedown: swallow,
      mouseup: swallow,
      click: (evt) => {
        swallow(evt);
        showOptionsPanel(!optionsPanelVisible);
        showPointerButton();
      }
    }
  }, createElement('img', { src: logoOrangeUrl, alt: '' }));
  btn.setAttribute('role', 'button');
  document.body.appendChild(btn);
  pointerButton = btn;
  syncPointerButtonTheme();
  return btn;
}

// The button follows the panel's theme: the same logo variant as the panel
// heading, and a class per variant for the ring and hover colours in ui.css.
function syncPointerButtonTheme() {
  if (!pointerButton) return;
  const variant = currentLogoVariant();
  for (const key of Object.keys(LOGO_URLS)) pointerButton.classList.toggle(`ytaf-${key}`, key === variant);
  const img = pointerButton.firstChild;
  if (img && img.getAttribute('src') !== LOGO_URLS[variant]) img.setAttribute('src', LOGO_URLS[variant]);
}

function showPointerButton() {
  if (!configRead('pointerSettingsButton') || !document.body) return;
  if (!pointerButton) pointerButton = createPointerButton();
  pointerButton.classList.toggle('ytaf-below-clock', configRead('clockMode') !== 'off');
  pointerButton.classList.add('ytaf-visible');
  clearTimeout(pointerButtonTimer);
  pointerButtonTimer = setTimeout(hidePointerButton, POINTER_BUTTON_HIDE_MS);
}

document.addEventListener('mousemove', (evt) => {
  // Chrome sends a synthetic mousemove with unchanged coordinates when the
  // page scrolls under a resting pointer; only a real move counts.
  if (evt.clientX === lastPointerX && evt.clientY === lastPointerY) return;
  lastPointerX = evt.clientX;
  lastPointerY = evt.clientY;
  showPointerButton();
}, true);
// webOS reports the pointer appearing and disappearing (it hides on a D-pad
// press or after a few idle seconds).
document.addEventListener('cursorStateChange', (evt) => {
  if (evt.detail && evt.detail.visibility === false) hidePointerButton();
});
window.addEventListener('keydown', (evt) => {
  if (evt.keyCode in ARROW_KEY_CODE) hidePointerButton();
}, true);
// Picking a video with the pointer must not leave the button over it.
window.addEventListener('ytaf-page-update', (evt) => {
  if (evt.detail.isWatch || evt.detail.isShorts) hidePointerButton();
});
configAddChangeListener('pointerSettingsButton', (evt) => { if (!evt.detail.newValue) hidePointerButton(); });

// The AI label and Most Replayed lookups ask as YouTube's web client, whose
// version YouTube may stop taking (web-client.js).
onWebClientRefused(() => showNotification('YouTube refused the AI label and Most Replayed lookups: the app needs an update', 8000));

// Apply initial states on boot
syncUiBrightness();
syncTrackingBlock();

// Startup hint. It used to fire a fixed 2s after the script loaded and stay
// 3s, so on a TV still showing the splash or the account picker it came and
// went unseen. Wait instead until YouTube shows a real page (a
// WEB_PAGE_TYPE_* class on <body> that is not the account selector), then
// show it a little longer. Gives up waiting after 30s and shows it anyway.
(function showStartupHint() {
  const startedAt = Date.now();
  const pageReady = () => {
    const cls = (document.body && document.body.className) || '';
    return cls.indexOf('WEB_PAGE_TYPE_') !== -1 && cls.indexOf(SELECTORS.ACCOUNT_SELECTOR) === -1;
  };
  const check = () => {
    if (pageReady() || Date.now() - startedAt > 30000) {
      // The key bound at start (a viewer may have moved the menu off Green).
      const label = startupMenuKey.toUpperCase();
      setTimeout(() => showNotification(`Press [${label}] to open the settings`, 6000), 1000);
      return;
    }
    setTimeout(check, 500);
  };
  setTimeout(check, 1000);
})();
