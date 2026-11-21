/**
 * Subtitles: YouTube's own caption style is kept, and a position of our own.
 *
 * KEEPING THE STYLE
 *   YouTube TV keeps the caption style chosen in its settings (font, size,
 *   colours, background) in localStorage as yt-player-caption-display-settings,
 *   a record of { data, expiration, creation } that runs out at its
 *   expiration (TizenTube's users saw it go after about a month); then, and
 *   whenever localStorage is emptied, the style went back to YouTube's
 *   default. Here the record's expiration is moved a year on, before
 *   YouTube reads it, and its data is copied to the settings
 *   (captionStyleBackup); a record that is gone is written back from the copy.
 *   After localStorage was emptied, the copy that comes back with the settings
 *   (config-backup.js) is written over the default YouTube put there meanwhile.
 *   Looked at when the app starts, when the page changes (at most every 5 s,
 *   so a style changed in YouTube's settings is copied once they are left) and
 *   when the app goes to the background. No setting. From TizenTube
 *   (reisxd/TizenTube#608), as VacuumTube's and TizenTube's users asked for.
 *
 * SUBTITLE POSITION (Player)
 *   Default leaves the subtitles where YouTube puts them; Higher and Highest
 *   lift the whole caption area, for a TV or soundbar that covers the bottom of
 *   the picture, or text burnt into the video. A class on <html>, read by a
 *   static rule, so a caption window YouTube draws again keeps it.
 */
import { configRead, configWrite, configAddChangeListener, configFlush, subtitleDelayMs, configRestorePending } from './config.js';

const CAPTION_KEYS = ['yt-player-caption-display-settings'];
const BACKUP_KEY = 'captionStyleBackup';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// Moved on again only this close to running out, so nothing is written on most starts.
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_CHECK_GAP_MS = 5000;

let lastCheck = 0;
// Records not there at the first look (localStorage emptied). One that shows
// up before the settings come back from their copy is YouTube's default: it is
// not copied, and the restored copy is written over it (toWriteBack: until
// localStorage takes it, before anything is copied from the record).
const missingAtStart = new Set();
const toWriteBack = {};
let firstLook = true;

/** The record's data as a string, or null when the record is not one of YouTube's. */
function readRecord(raw) {
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || typeof record.data !== 'string') return null;
    return record;
  } catch { return null; }
}

export function keepCaptionStyle() {
  lastCheck = Date.now();
  let storage;
  try { storage = window.localStorage; } catch { return; }
  if (!storage) return;
  const stored = configRead(BACKUP_KEY);
  const backups = Object.assign({}, stored && typeof stored === 'object' ? stored : {});
  let changed = false;
  const now = Date.now();
  const pending = configRestorePending();
  for (const key of CAPTION_KEYS) {
    try {
      const raw = storage.getItem(key);
      if (firstLook && !raw) missingAtStart.add(key);
      if (typeof toWriteBack[key] === 'string') {
        storage.setItem(key, JSON.stringify({ data: toWriteBack[key], expiration: now + ONE_YEAR_MS, creation: now }));
        delete toWriteBack[key];
        continue;
      }
      if (raw) {
        const record = readRecord(raw);
        if (!record) continue;
        if (pending && missingAtStart.has(key)) continue;
        if (backups[key] !== record.data) { backups[key] = record.data; changed = true; }
        if (!(Number(record.expiration) - now > RENEW_BEFORE_MS)) {
          storage.setItem(key, JSON.stringify({ data: record.data, expiration: now + ONE_YEAR_MS, creation: Number(record.creation) || now }));
        }
      } else if (typeof backups[key] === 'string') {
        storage.setItem(key, JSON.stringify({ data: backups[key], expiration: now + ONE_YEAR_MS, creation: now }));
        console.info('[CaptionStyle] Restored', key);
      }
    } catch { /* storage refused: the next look */ }
  }
  firstLook = false;
  if (changed) configWrite(BACKUP_KEY, backups);
}

const POSITION_CLASSES = { raised: 'ytaf-subs-raised', high: 'ytaf-subs-high' };
const STYLE_ID = 'ytaf-subtitle-position';

function injectPositionStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    `html.${POSITION_CLASSES.raised} .ytp-caption-window-container { transform: translateY(-8vh) !important; }\n` +
    `html.${POSITION_CLASSES.high} .ytp-caption-window-container { transform: translateY(-16vh) !important; }`;
  (document.head || document.documentElement).appendChild(style);
}

export function applySubtitlePosition() {
  const mode = configRead('subtitlePosition');
  const root = document.documentElement;
  for (const name of Object.keys(POSITION_CLASSES)) {
    if (name === mode) root.classList.add(POSITION_CLASSES[name]);
    else root.classList.remove(POSITION_CLASSES[name]);
  }
  if (POSITION_CLASSES[mode]) injectPositionStyle();
}

/*
 * SUBTITLE DELAY (Player)
 *   Subtitles shown earlier or later than the video says, for a track out of
 *   step with the sound (a reupload, a dub). YouTube loads a track as JSON
 *   ("json3": wireMagic pb3, events with tStartMs) and parses it with
 *   JSON.parse, so each event's start is moved before the player sees it.
 *   Applies to the next track loaded (subtitles turned off and on, another
 *   video). From MickLesk's fork (subtitle-offset.ts).
 */
export function shiftCaptions(track, delayMs) {
  if (!track || track.wireMagic !== 'pb3' || !Array.isArray(track.events) || !delayMs) return 0;
  let moved = 0;
  for (const event of track.events) {
    if (!event || typeof event !== 'object' || typeof event.tStartMs !== 'number') continue;
    event.tStartMs = Math.max(0, event.tStartMs + delayMs);
    moved++;
  }
  return moved;
}

// Kept current: read on every JSON.parse the app makes.
let delayMs = 0;

function installDelayHook() {
  const original = JSON.parse;
  JSON.parse = function (text, reviver) {
    const out = original.call(this, text, reviver);
    // With a delay set, a caption track only (shiftCaptions checks wireMagic
    // on the parsed object, wherever the text had it): everything else
    // YouTube parses goes through with a property read.
    if (delayMs) {
      try { shiftCaptions(out, delayMs); } catch { /* the track as it came */ }
    }
    return out;
  };
}

if (typeof window !== 'undefined') {
  delayMs = subtitleDelayMs(configRead('subtitleDelay'));
  configAddChangeListener('subtitleDelay', ({ detail }) => { delayMs = subtitleDelayMs(detail.newValue); });
  installDelayHook();
  keepCaptionStyle();
  window.addEventListener('ytaf-page-update', () => {
    if (Date.now() - lastCheck >= MIN_CHECK_GAP_MS) keepCaptionStyle();
  });
  // config.js writes its waiting changes on this event before this listener
  // runs: a style copied now is written at once too, before the TV suspends the app.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    keepCaptionStyle();
    configFlush();
  });
  // A copy that came back with the settings (config-backup.js) after the look
  // above: written over a record YouTube put there since (its default).
  configAddChangeListener(BACKUP_KEY, (evt) => {
    const copy = evt.detail.newValue;
    if (configRestorePending() && copy && typeof copy === 'object') {
      for (const key of missingAtStart) if (typeof copy[key] === 'string') toWriteBack[key] = copy[key];
    }
    keepCaptionStyle();
  });
  applySubtitlePosition();
  configAddChangeListener('subtitlePosition', applySubtitlePosition);
}
