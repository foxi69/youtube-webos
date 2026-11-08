import { configRead } from './config.js';

/**
 * Hide Left Menu Entries: the entries of YouTube's left menu (Music, Gaming,
 * News, ...) that the settings panel lists, each with its own switch.
 *
 * The menu comes in the guide response, through the JSON.parse hook
 * (adblock.js). Its fixed entries - the ones without a thumbnail, so not the
 * subscribed channels - are kept in localStorage for the panel; the ones
 * switched off are taken out of the response, and a section left empty with
 * them. YouTube loads the menu when the app starts, so a change applies from
 * the next start. (After MickLesk's fork.)
 */

const ENTRIES_KEY = 'ytaf-sidebar-entries';
export const SIDEBAR_ENTRIES_EVENT = 'ytaf-sidebar-entries';
// Home stays: the app opens on it, and without it there is no way back. On
// webOS 25 Home is FEtopics (its topics are FEtopics_music and so on).
const KEEP = { FEwhat_to_watch: true, FEtopics: true };

let entries = null;
let entriesJson = '';

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) {
    let out = '';
    for (let i = 0; i < value.runs.length; i++) {
      const run = value.runs[i];
      if (run && typeof run.text === 'string') out += run.text;
    }
    return out;
  }
  return '';
}

/** An entry's lasting id: the page it opens, or "search". */
function entryId(entry) {
  const endpoint = entry.navigationEndpoint || entry.endpoint;
  if (!endpoint || typeof endpoint !== 'object') return null;
  const browseId = endpoint.browseEndpoint && endpoint.browseEndpoint.browseId;
  if (typeof browseId === 'string' && browseId) return browseId;
  if (endpoint.searchEndpoint) return 'search';
  return null;
}

/** The left menu's entries as last seen, [{ id, title }], for the panel. */
export function getSidebarEntries() {
  if (entries) return entries;
  entries = [];
  let raw = null;
  try {
    raw = window.localStorage.getItem(ENTRIES_KEY);
    const list = raw ? JSON.parse(raw) : null;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        // A kept entry (Home) saved by an older version gets no switch.
        if (e && typeof e.id === 'string' && typeof e.title === 'string' && !KEEP[e.id]) entries.push({ id: e.id, title: e.title });
      }
    }
  } catch {
    // Unreadable: learnt again from the next menu.
  }
  // As stored, so a list cleaned here is written back by the next menu.
  entriesJson = raw || '[]';
  return entries;
}

function saveEntries(list) {
  getSidebarEntries();
  const json = JSON.stringify(list);
  if (json === entriesJson) return;
  entries = list;
  entriesJson = json;
  try {
    window.localStorage.setItem(ENTRIES_KEY, json);
  } catch {
    // Not critical: the panel lists them from memory until the app closes.
  }
  try {
    window.dispatchEvent(new CustomEvent(SIDEBAR_ENTRIES_EVENT));
  } catch {
    // No listener to tell.
  }
}

export function hiddenIds() {
  const value = configRead('hiddenSidebarEntries');
  return Array.isArray(value) ? value : [];
}

/**
 * Whether the JSON.parse hook is needed for the left menu: while an entry is
 * hidden, or while the panel has no entries to list yet.
 */
export function sidebarHookRequired() {
  return hiddenIds().length > 0 || getSidebarEntries().length === 0;
}

/**
 * Filters a guide response in place and keeps its entries for the panel.
 * Anything else is left alone, at the cost of a look at its first item.
 */
export function applySidebar(data) {
  const items = data.items;
  if (!Array.isArray(items) || !items.length) return;
  const first = items[0];
  if (!first || (!first.guideSectionRenderer && !first.guideEntryRenderer)) return;

  const hidden = hiddenIds();
  const seen = [];
  const seenIds = {};

  // Keeps an entry, or not; and lists it for the panel.
  const keep = (item) => {
    const entry = item && item.guideEntryRenderer;
    if (!entry) return true;
    const id = entryId(entry);
    if (!id || KEEP[id]) return true;
    // A subscribed channel has its picture as a thumbnail.
    if (entry.thumbnail) return true;
    if (!seenIds[id]) {
      seenIds[id] = true;
      seen.push({ id, title: textOf(entry.formattedTitle) || textOf(entry.title) || id });
    }
    return hidden.indexOf(id) === -1;
  };

  let w = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const section = item && item.guideSectionRenderer;
    if (section && Array.isArray(section.items)) {
      const list = section.items;
      let k = 0;
      for (let j = 0; j < list.length; j++) {
        if (keep(list[j])) list[k++] = list[j];
      }
      const emptied = k === 0 && list.length > 0;
      list.length = k;
      if (emptied) continue;
    } else if (!keep(item)) {
      continue;
    }
    items[w++] = item;
  }
  items.length = w;

  if (!seen.length) return;
  // A menu that comes without a hidden entry (a smaller one) leaves it
  // listed, or its switch would be gone and it could not be shown again.
  const known = getSidebarEntries();
  for (let i = 0; i < known.length; i++) {
    if (!seenIds[known[i].id] && hidden.indexOf(known[i].id) !== -1) seen.push(known[i]);
  }
  saveEntries(seen);
}
