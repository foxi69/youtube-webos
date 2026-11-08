/**
 * What the feed filters read from a video item: its title, its channel, its
 * length and how much of it was watched. The items come in three shapes - the
 * tileRenderer of the older TV layouts, the lockupViewModel of the current one,
 * and the video renderers some surfaces (search, watch-next) still send - and
 * each field is looked for in all three. (Idea from MickLesk's fork.)
 *
 * Every reader returns null (or 0) when the item has no such field, so a
 * channel, a playlist or a live stream without a length is never dropped for a
 * field it does not have.
 */

import { uiLang } from './utils.js';

// Our own emoji sentinels (adblock.js) and the other invisible marks a title
// can carry; they must not stop a keyword or a channel name from matching.
const INVISIBLE_RE = /[\u200B\u200C\u2060\uFEFF]/g;
const DURATION_RE = /^\d{1,2}(?::\d{2}){1,2}$/;

/** The text of simpleText, runs, a view model's content, or a plain string. */
function textOf(value) {
  if (!value) return null;
  let text = null;
  if (typeof value === 'string') text = value;
  else if (typeof value.simpleText === 'string') text = value.simpleText;
  else if (typeof value.content === 'string') text = value.content;
  else if (Array.isArray(value.runs)) {
    text = '';
    for (let i = 0; i < value.runs.length; i++) {
      const run = value.runs[i];
      if (run && typeof run.text === 'string') text += run.text;
    }
  }
  return text === null ? null : text.replace(INVISIBLE_RE, '').trim();
}

function videoRendererOf(item) {
  return item.videoRenderer || item.gridVideoRenderer || item.compactVideoRenderer || null;
}

function lockupOverlays(item) {
  const overlays = item.lockupViewModel?.contentImage?.thumbnailViewModel?.overlays;
  return Array.isArray(overlays) ? overlays : null;
}

function tileOverlays(item) {
  const overlays = item.tileRenderer?.header?.tileHeaderRenderer?.thumbnailOverlays;
  return Array.isArray(overlays) ? overlays : null;
}

export function itemTitle(item) {
  const tile = item.tileRenderer;
  if (tile) return textOf(tile.metadata?.tileMetadataRenderer?.title);
  const lockup = item.lockupViewModel;
  if (lockup) return textOf(lockup.metadata?.lockupMetadataViewModel?.title);
  const video = videoRendererOf(item);
  return video ? textOf(video.title) : null;
}

/** The channel: the first metadata line of a tile or a lockup, a video's byline. */
export function itemChannel(item) {
  const tile = item.tileRenderer;
  if (tile) {
    return textOf(tile.metadata?.tileMetadataRenderer?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text);
  }
  const lockup = item.lockupViewModel;
  if (lockup) {
    const rows = lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows;
    return textOf(rows?.[0]?.metadataParts?.[0]?.text);
  }
  const video = videoRendererOf(item);
  if (!video) return null;
  return textOf(video.ownerText) || textOf(video.shortBylineText) || textOf(video.longBylineText);
}

function parseDuration(text) {
  if (!text || !DURATION_RE.test(text)) return null;
  const parts = text.split(':');
  let seconds = 0;
  for (let i = 0; i < parts.length; i++) seconds = seconds * 60 + Number(parts[i]);
  return seconds;
}

function badgeDuration(badges) {
  if (!Array.isArray(badges)) return null;
  for (let i = 0; i < badges.length; i++) {
    const seconds = parseDuration(textOf(badges[i]?.thumbnailBadgeViewModel?.text));
    if (seconds !== null) return seconds;
  }
  return null;
}

/** The length in seconds, from the duration on the thumbnail, or null. */
export function itemDurationSeconds(item) {
  const tiles = tileOverlays(item);
  if (tiles) {
    for (let i = 0; i < tiles.length; i++) {
      const seconds = parseDuration(textOf(tiles[i]?.thumbnailOverlayTimeStatusRenderer?.text));
      if (seconds !== null) return seconds;
    }
    return null;
  }
  const lockups = lockupOverlays(item);
  if (lockups) {
    for (let i = 0; i < lockups.length; i++) {
      const overlay = lockups[i];
      if (!overlay) continue;
      const seconds = badgeDuration(overlay.thumbnailBottomOverlayViewModel?.badges) ??
        badgeDuration(overlay.thumbnailOverlayBadgeViewModel?.thumbnailBadges);
      if (seconds !== null) return seconds;
    }
    return null;
  }
  const video = videoRendererOf(item);
  return video ? parseDuration(textOf(video.lengthText)) : null;
}

function resumePercent(overlays) {
  if (!Array.isArray(overlays)) return 0;
  for (let i = 0; i < overlays.length; i++) {
    const pct = overlays[i]?.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched;
    if (typeof pct === 'number') return pct;
  }
  return 0;
}

/** How much of the video was watched, 0-100: the red bar under the thumbnail. */
export function itemWatchedPercent(item) {
  const tiles = tileOverlays(item);
  if (tiles) return resumePercent(tiles);
  const lockups = lockupOverlays(item);
  if (lockups) {
    for (let i = 0; i < lockups.length; i++) {
      const overlay = lockups[i];
      if (!overlay) continue;
      const bar = overlay.thumbnailBottomOverlayViewModel?.progressBar?.thumbnailOverlayProgressBarViewModel ||
        overlay.thumbnailOverlayProgressBarViewModel;
      if (bar && typeof bar.startPercent === 'number') return bar.startPercent;
    }
    return 0;
  }
  const video = videoRendererOf(item);
  return video ? resumePercent(video.thumbnailOverlays) : 0;
}

/**
 * How old a video is, from the "2 years ago" its tile shows, where
 * intlAgePatterns() below has no answer (an engine without
 * Intl.RelativeTimeFormat, or the web's wording): [pattern, [[unit stem, days], ...]]. The first group
 * is the number, the second the unit; a unit is matched by the first stem it
 * starts with, so longer stems come before the shorter ones they begin with.
 * Seconds, minutes and hours count as 0 days. (Idea from MickLesk's fork,
 * which reads English and German.)
 */
const AGE_PATTERNS = [
  [/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i,
    [['second', 0], ['minute', 0], ['hour', 0], ['day', 1], ['week', 7], ['month', 30], ['year', 365]]],
  [/(\d+)\s*(másodperce|perce|órája|napja|hete|hónapja|éve)/i,
    [['másodperc', 0], ['perc', 0], ['órá', 0], ['nap', 1], ['het', 7], ['hónap', 30], ['év', 365]]],
  // The TV app's Hungarian: "2 évvel ezelőtt", "3 héttel ezelőtt".
  [/(\d+)\s*(másodperc|perc|órá|nap|hét|hónap|év)\S*\s+ezelőtt/i,
    [['másodperc', 0], ['perc', 0], ['órá', 0], ['nap', 1], ['hét', 7], ['hónap', 30], ['év', 365]]],
  [/vor\s+(\d+)\s*(Sekunde|Minute|Stunde|Tag|Woche|Monat|Jahr)/i,
    [['sek', 0], ['min', 0], ['stu', 0], ['tag', 1], ['woc', 7], ['mon', 30], ['jah', 365]]],
  [/hace\s+(\d+)\s*(segundo|minuto|hora|d[ií]a|semana|mes|a[ñn]o)/i,
    [['seg', 0], ['min', 0], ['hor', 0], ['d', 1], ['sem', 7], ['mes', 30], ['a', 365]]],
  [/il y a\s+(\d+)\s*(seconde|minute|heure|jour|semaine|mois|an)/i,
    [['sec', 0], ['min', 0], ['heu', 0], ['jou', 1], ['sem', 7], ['moi', 30], ['an', 365]]],
  [/(\d+)\s*(second[oi]|minut[oi]|or[ae]|giorn[oi]|settiman[ae]|mes[ei]|ann[oi])\s+fa/i,
    [['sec', 0], ['min', 0], ['or', 0], ['gio', 1], ['set', 7], ['mes', 30], ['ann', 365]]],
  [/há\s+(\d+)\s*(segundo|minuto|hora|dia|semana|m[eê]s|ano)/i,
    [['seg', 0], ['min', 0], ['hor', 0], ['dia', 1], ['sem', 7], ['m', 30], ['ano', 365]]],
  [/(\d+)\s*(seconde|minu|uur|dag|we+k|maand|jaar)\S*\s+geleden/i,
    [['sec', 0], ['min', 0], ['uur', 0], ['dag', 1], ['we', 7], ['maa', 30], ['jaa', 365]]],
  [/(\d+)\s*(sekund|minut|godzin|dzie|dni|tydzie|tygodni|miesi|rok|lat)\S*\s+temu/i,
    [['sek', 0], ['min', 0], ['god', 0], ['dzie', 1], ['dni', 1], ['tyd', 7], ['tyg', 7], ['mie', 30], ['rok', 365], ['lat', 365]]],
  [/(\d+)\s*(секунд|минут|час|дн|день|недел|месяц|год|лет)\S*\s+назад/i,
    [['сек', 0], ['мин', 0], ['час', 0], ['дн', 1], ['ден', 1], ['нед', 7], ['мес', 30], ['год', 365], ['лет', 365]]],
  [/(\d+)\s*(секунд|хвилин|годин|дн|день|тиж|місяц|рік|рок)\S*\s+тому/i,
    [['сек', 0], ['хви', 0], ['год', 0], ['дн', 1], ['ден', 1], ['тиж', 7], ['міс', 30], ['рік', 365], ['рок', 365]]],
  [/(\d+)\s*(saniye|dakika|saat|gün|hafta|ay|yıl)\s+önce/i,
    [['san', 0], ['dak', 0], ['saa', 0], ['gün', 1], ['haf', 7], ['ay', 30], ['yıl', 365]]],
  [/(\d+)\s*(分钟|分鐘|小时|小時|个月|個月|[秒天周週年])前/,
    [['秒', 0], ['分', 0], ['小', 0], ['天', 1], ['周', 7], ['週', 7], ['个', 30], ['個', 30], ['年', 365]]],
  [/(\d+)\s*(時間|週間|か月|ヶ月|[秒分日年])前/,
    [['秒', 0], ['分', 0], ['時', 0], ['日', 1], ['週', 7], ['か', 30], ['ヶ', 30], ['年', 365]]],
  [/(\d+)\s*(시간|개월|[초분일주년])\s*전/,
    [['초', 0], ['분', 0], ['시', 0], ['일', 1], ['주', 7], ['개', 30], ['년', 365]]]
];

function collectStrings(value, out, depth) {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || depth > 8) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) collectStrings(value[i], out, depth + 1);
    return;
  }
  for (const key in value) collectStrings(value[key], out, depth + 1);
}

/**
 * The texts of a tile's lines, a lockup's metadata rows or a video's date,
 * in the order they are shown: everything but the title.
 */
function ageTexts(item) {
  const tile = item.tileRenderer;
  let part;
  if (tile) part = tile.metadata?.tileMetadataRenderer?.lines;
  else if (item.lockupViewModel) part = item.lockupViewModel.metadata?.lockupMetadataViewModel?.metadata;
  else {
    const video = videoRendererOf(item);
    part = video ? video.publishedTimeText : null;
  }
  const out = [];
  collectStrings(part, out, 0);
  return out;
}

const INTL_UNITS = [['second', 0], ['minute', 0], ['hour', 0], ['day', 1], ['week', 7], ['month', 30], ['year', 365]];
// Numbers that reach every plural form ("1 год", "2 года", "5 лет", "21 год").
const INTL_SAMPLES = [1, 2, 3, 5, 11, 21, 22, 25];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneSpace = (s) => s.replace(/\s+/g, ' ');
// Built once per language: YouTube's HL may only be known after the first feed.
let intlAges = { lang: null, patterns: [], digits: '' };

/** A number in the language's own digits ("۲" in Persian) or in 0-9. */
function parseNumber(text, digits) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const d = digits.indexOf(text[i]);
    out += d === -1 ? text[i] : String(d);
  }
  return Number(out);
}

/**
 * "2 years ago" as the browser words it in YouTube's language, for any
 * language: [RegExp, days per unit, or the days of a wording with no number in
 * it (Arabic "قبل سنتين", "two years ago")], or none where
 * Intl.RelativeTimeFormat is missing (Chromium < 71, webOS 3-5). YouTube's TV
 * app words it the same way, e.g. Hungarian "2 évvel ezelőtt", where the web
 * says "2 éve".
 */
function intlAgePatterns() {
  const lang = uiLang();
  if (intlAges.lang === lang) return intlAges;
  intlAges = { lang, patterns: [], digits: '' };
  try {
    const format = new Intl.RelativeTimeFormat(lang, { numeric: 'always' });
    // The language's digits 0-9, in order ("۰۱۲..." in Persian).
    const local = new Intl.NumberFormat(lang, { useGrouping: false }).format(9876543210);
    const digits = local.length === 10 ? local.split('').reverse().join('') : '0123456789';
    const number = '([0-9' + (digits === '0123456789' ? '' : escapeRe(digits)) + ']+)';
    const seen = {};
    for (let u = 0; u < INTL_UNITS.length; u++) {
      for (let n = 0; n < INTL_SAMPLES.length; n++) {
        const parts = format.formatToParts(-INTL_SAMPLES[n], INTL_UNITS[u][0]);
        let before = '', after = '', hasNumber = false;
        for (let p = 0; p < parts.length; p++) {
          if (parts[p].type === 'literal') { if (hasNumber) after += parts[p].value; else before += parts[p].value; }
          else hasNumber = true;
        }
        const source = hasNumber
          ? escapeRe(oneSpace(before)) + number + escapeRe(oneSpace(after))
          : escapeRe(oneSpace(before));
        if (seen[source]) continue;
        seen[source] = true;
        intlAges.patterns.push([new RegExp(source, 'i'), INTL_UNITS[u][1], hasNumber ? null : INTL_SAMPLES[n] * INTL_UNITS[u][1]]);
      }
    }
    intlAges.digits = digits;
  } catch { /* no Intl.RelativeTimeFormat: AGE_PATTERNS alone */ }
  return intlAges;
}

function daysIn(text) {
  const intl = intlAgePatterns();
  const spaced = oneSpace(text);
  for (let i = 0; i < intl.patterns.length; i++) {
    const pattern = intl.patterns[i];
    const match = pattern[0].exec(spaced);
    if (match) return pattern[2] !== null ? pattern[2] : parseNumber(match[1], intl.digits) * pattern[1];
  }
  for (let i = 0; i < AGE_PATTERNS.length; i++) {
    const match = AGE_PATTERNS[i][0].exec(text);
    if (!match) continue;
    const unit = match[2].toLowerCase();
    const units = AGE_PATTERNS[i][1];
    for (let j = 0; j < units.length; j++) {
      if (unit.indexOf(units[j][0]) === 0) return Number(match[1]) * units[j][1];
    }
  }
  return null;
}

/**
 * How many days ago a video came out, from the "2 years ago" its tile shows,
 * or null: no such text, or a language AGE_PATTERNS does not know.
 */
export function itemAgeDays(item) {
  // The date comes after the channel: read from the last text back, so a
  // channel named "Class of 2 years ago" is not taken for the date.
  const texts = ageTexts(item);
  for (let i = texts.length - 1; i >= 0; i--) {
    const days = daysIn(texts[i]);
    if (days !== null) return days;
  }
  return null;
}

/**
 * The playlist (a Mix too) the video of a watch-next response plays from, or
 * null: the one the response names for the playing video (as Hide Recommended
 * Videos reads it), its playlist panel, or the address. Its row under the
 * player is the playlist, and stays whole.
 */
export function playingPlaylistId(data) {
  const next = data && data.contents && data.contents.singleColumnWatchNextResults;
  if (!next) return null;
  const current = data.currentVideoEndpoint && data.currentVideoEndpoint.watchEndpoint;
  if (current && typeof current.playlistId === 'string' && current.playlistId) return current.playlistId;
  const panel = next.playlist && next.playlist.playlist;
  if (panel && typeof panel.playlistId === 'string' && panel.playlistId) return panel.playlistId;
  const match = /[?&]list=([^&]+)/.exec(window.location.hash || '');
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch (e) {
    return null; // a malformed escape in the address
  }
}

/**
 * Whether a playlist id is a Mix: YouTube's generated mixes and radios start
 * with "RD" (RD<video id>, RDMM "My Mix", RDEM, RDAMVM...). RDCLAK ones are
 * YouTube Music's albums and charts, which are generated too but are not
 * mixes, so they stay.
 */
function isMixId(id) {
  return typeof id === 'string' && id.indexOf('RD') === 0 && id.indexOf('RDCLAK') !== 0;
}

/** The playlist a browse endpoint opens (VL<playlist id>), or null. */
function browsePlaylistId(endpoint) {
  const id = endpoint && endpoint.browseId;
  return typeof id === 'string' && id.indexOf('VL') === 0 ? id.slice(2) : null;
}

/** Whether a command opens a Mix: its page, or the Mix played as a playlist. */
function opensMix(command) {
  if (!command) return false;
  return isMixId(browsePlaylistId(command.browseEndpoint)) ||
    isMixId(command.watchPlaylistEndpoint && command.watchPlaylistEndpoint.playlistId) ||
    isMixId(command.watchEndpoint && command.watchEndpoint.playlistId);
}

/**
 * Whether an item is a Mix: a tile or a lockup of the MIX type; one that opens
 * a Mix's page (VLRD...), whatever its type; one of the playlist type whose id
 * or command is a Mix; or one of the older radio renderers. A video that
 * merely plays inside a Mix (its watch endpoint names the Mix as its
 * playlist) is a video and stays. (Idea from MickLesk's fork.)
 */
export function isMixItem(item) {
  const tile = item.tileRenderer;
  if (tile) {
    const type = typeof tile.contentType === 'string' ? tile.contentType : '';
    if (type.slice(-4) === '_MIX') return true;
    const command = tile.onSelectCommand || {};
    if (isMixId(browsePlaylistId(command.browseEndpoint))) return true;
    if (command.watchPlaylistEndpoint) return isMixId(command.watchPlaylistEndpoint.playlistId);
    return type === 'TILE_CONTENT_TYPE_PLAYLIST' && (isMixId(tile.contentId) || opensMix(command));
  }
  const lockup = item.lockupViewModel;
  if (lockup) {
    if (lockup.contentType === 'LOCKUP_CONTENT_TYPE_MIX') return true;
    if (lockup.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST') return false;
    const context = lockup.rendererContext && lockup.rendererContext.commandContext;
    const tap = context && context.onTap && context.onTap.innertubeCommand;
    return isMixId(lockup.contentId) || opensMix(tap);
  }
  return !!(item.radioRenderer || item.compactRadioRenderer || item.gridRadioRenderer);
}

/**
 * The browse page a response belongs to: the browse_id the response names in
 * its tracking parameters, else the page in the address (`#/browse?c=FE...`).
 * A continuation names no page of its own, so the address is what tells it.
 */
function browseIdOf(data) {
  const services = data && data.responseContext && data.responseContext.serviceTrackingParams;
  if (Array.isArray(services)) {
    for (let i = 0; i < services.length; i++) {
      const params = services[i] && services[i].params;
      if (!Array.isArray(params)) continue;
      for (let j = 0; j < params.length; j++) {
        if (params[j] && params[j].key === 'browse_id' && typeof params[j].value === 'string') return params[j].value;
      }
    }
  }
  const match = /[?&]c=([^&]+)/.exec(window.location.hash || '');
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Whether watched videos stay in this response: the history, the library and
 * playlists (Watch later included) list videos because they were watched or
 * saved, and would empty out without them.
 */
export function keepsWatchedVideos(data) {
  const id = browseIdOf(data);
  return id === 'FEhistory' || id === 'FElibrary' || id === 'FEmy_youtube' || id.slice(0, 2) === 'VL';
}
