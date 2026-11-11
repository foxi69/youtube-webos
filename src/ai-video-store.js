/**
 * Keeps a bounded, expiring memory of confirmed AI labels; DOM checks learn
 * IDs on first encounter, and adblock.js uses this store to remove them later.
 * And, further down, of the videos found to have none, so they are not asked
 * about again at every start of the app.
 */
const STORAGE_KEY = 'ytaf-ai-videos';
const MAX_ENTRIES = 2000;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WRITE_DELAY_MS = 200;
const entries = new Map();
let loaded = false;
let writeTimer = null;

function persistSoon() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const values = [];
      entries.forEach((entry) => void values.push(entry));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    } catch { /* Storage can be disabled or full; the in-memory index still works. */ }
  }, WRITE_DELAY_MS);
}

function load() {
  if (loaded) return;
  loaded = true;
  let values;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    values = JSON.parse(raw);
    if (!Array.isArray(values)) return;
  } catch { return; }

  const now = Date.now();
  let changed = false;
  for (let i = 0; i < values.length; i++) {
    const entry = values[i];
    if (!entry || typeof entry.id !== 'string' || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) { changed = true; continue; }
    if (entries.has(entry.id)) entries.delete(entry.id);
    entries.set(entry.id, { id: entry.id, expiresAt: entry.expiresAt });
    if (entries.size > MAX_ENTRIES) { entries.delete(entries.keys().next().value); changed = true; }
  }
  if (changed) persistSoon();
}

export function isAiVideoStored(id) {
  load();
  const entry = entries.get(id);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(id);
    persistSoon();
    return false;
  }
  return true;
}

export function recordAiVideo(id) {
  if (typeof id !== 'string' || !id) return;
  forgetNotAi(id);
  load();
  if (entries.has(id)) entries.delete(id);
  entries.set(id, { id, expiresAt: Date.now() + TTL_MS });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  persistSoon();
}

export function removeAiVideo(id) {
  load();
  if (entries.delete(id)) persistSoon();
}

/*
 * The videos YouTube answered "no AI label" for, kept for a week: Home shows
 * much the same videos from one start of the app to the next, and without
 * this every one of them was asked about again each time (the lookup's own
 * memory lasts an hour and ends with the app). A video labelled later is
 * noticed when its entry runs out.
 *
 * Stored as "id:day,id:day" (the day it runs out, in days since 1970), not
 * JSON: up to NOT_AI_MAX entries are read with one split.
 */
const NOT_AI_KEY = 'ytaf-not-ai-videos';
const NOT_AI_MAX = 3000;
const NOT_AI_DAYS = 7;
const NOT_AI_WRITE_DELAY_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
// id -> the time its answer runs out; insertion order is age order.
const notAi = new Map();
let notAiLoaded = false;
let notAiTimer = null;

function saveNotAiSoon() {
  if (notAiTimer !== null) return;
  notAiTimer = setTimeout(() => {
    notAiTimer = null;
    try {
      const out = [];
      notAi.forEach((until, id) => { out.push(id + ':' + Math.round(until / DAY_MS)); });
      localStorage.setItem(NOT_AI_KEY, out.join(','));
    } catch { /* Storage disabled or full: remembered until the app closes. */ }
  }, NOT_AI_WRITE_DELAY_MS);
}

function loadNotAi() {
  if (notAiLoaded) return;
  notAiLoaded = true;
  let raw;
  try { raw = localStorage.getItem(NOT_AI_KEY); } catch { return; }
  if (typeof raw !== 'string' || !raw) return;
  const now = Date.now();
  const parts = raw.split(',');
  for (let i = 0; i < parts.length; i++) {
    const sep = parts[i].lastIndexOf(':');
    const until = sep > 0 ? Number(parts[i].slice(sep + 1)) * DAY_MS : NaN;
    // Not later than a new entry would run out: a clock set back, or a file
    // written by hand, cannot keep an answer for good.
    if (until > now && until <= now + (NOT_AI_DAYS + 1) * DAY_MS && notAi.size < NOT_AI_MAX) notAi.set(parts[i].slice(0, sep), until);
  }
}

/** The time until which `id` is known to carry no AI label, or 0. */
export function notAiUntil(id) {
  loadNotAi();
  const until = notAi.get(id);
  if (!until) return 0;
  if (until > Date.now()) return until;
  notAi.delete(id);
  saveNotAiSoon();
  return 0;
}

export function recordNotAiVideo(id) {
  if (typeof id !== 'string' || !id) return;
  loadNotAi();
  notAi.delete(id);
  notAi.set(id, Date.now() + NOT_AI_DAYS * DAY_MS);
  if (notAi.size > NOT_AI_MAX) notAi.delete(notAi.keys().next().value);
  saveNotAiSoon();
}

function forgetNotAi(id) {
  loadNotAi();
  if (notAi.delete(id)) saveNotAiSoon();
}
