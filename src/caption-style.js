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
import { configRead, configWrite, configAddChangeListener, configFlush } from './config.js';

const CAPTION_KEYS = ['yt-player-caption-display-settings'];
const BACKUP_KEY = 'captionStyleBackup';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// Moved on again only this close to running out, so nothing is written on most starts.
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_CHECK_GAP_MS = 5000;

let lastCheck = 0;

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
  for (const key of CAPTION_KEYS) {
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const record = readRecord(raw);
        if (!record) continue;
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

if (typeof window !== 'undefined') {
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
  // A copy that came back with the settings (config-backup.js) after the look above.
  configAddChangeListener(BACKUP_KEY, () => keepCaptionStyle());
  applySubtitlePosition();
  configAddChangeListener('subtitlePosition', applySubtitlePosition);
}
