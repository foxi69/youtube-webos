// DeArrow in the responses: every video tile of an InnerTube response, found
// by a bounded walk, is remembered with its video and gets what is decided
// for it: the title, the thumbnail, and the DeArrow badge in its metadata
// line. A tile seen before its video's answer is written to again when the
// answer lands (applyToVideo), so YouTube draws it right whenever it draws it
// from that response (scrolling, coming back to a page). YouTube keeps
// parsed responses and renders cached pages from them, so what each tile had
// is recorded once and can be put back.
//
// Two shapes of video tile: the tileRenderer of the TV layouts, and the
// lockupViewModel of the current one (search, some rows on webOS 25). The
// badge goes on tileRenderers only, whose metadata lines it joins.
import { configRead } from '../config.js';
import { itemTitle, itemDurationSeconds } from '../feed-filters.js';
import { TILES_PER_VIDEO, SCAN_MAX_DEPTH, SCAN_MAX_NODES, BADGE_MARK } from './constants.js';
import { videos } from './state.js';

const VIDEO_ID_RE = /^[\w-]{11}$/;

// Branches the walk never enters: they hold no tiles (the response context,
// the entity store) or copies of a tile's data that are not drawn as a tile
// (the long-press menu, the commands).
const SKIP_KEYS = {
  responseContext: true,
  frameworkUpdates: true,
  onLongPressCommand: true,
  onSelectCommand: true,
  onFocusCommand: true,
  rendererContext: true,
  trackingParams: true
};

// tile -> what YouTube had in it: { title, simpleText, runs, content,
// thumbnail, listKey, thumbnails, items, badge }; `items` and `badge` are the
// metadata line the DeArrow badge went into and the badge itself, while it is
// there.
const originals = new WeakMap();

// The metadata badge YouTube draws "4K", "HD" or "CC" with, as first seen in
// a response: copied for the DeArrow badge, so it takes the same shape and
// look. Until one is seen, the plain shape those badges have.
let badgeTemplate = { metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_SIMPLE' } };
let badgeLearned = false;

/** The video id of a video tile (a tileRenderer or a lockupViewModel), or null for anything else. */
function videoIdOf(node) {
  const tile = node.tileRenderer;
  if (tile) {
    const type = tile.contentType;
    if (type && type !== 'TILE_CONTENT_TYPE_VIDEO') return null;
    return typeof tile.contentId === 'string' && VIDEO_ID_RE.test(tile.contentId) ? tile.contentId : null;
  }
  const lockup = node.lockupViewModel;
  if (lockup && lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    return typeof lockup.contentId === 'string' && VIDEO_ID_RE.test(lockup.contentId) ? lockup.contentId : null;
  }
  return null;
}

/** A tile's title object: { simpleText } or { runs } on a tileRenderer, { content } on a lockup. */
const titleOf = (node) =>
  node.tileRenderer
    ? node.tileRenderer.metadata?.tileMetadataRenderer?.title || null
    : node.lockupViewModel.metadata?.lockupMetadataViewModel?.title || null;

/** A tile's thumbnail object and the key of its image list in it. */
function thumbnailOf(node) {
  if (node.tileRenderer) {
    const thumbnail = node.tileRenderer.header?.tileHeaderRenderer?.thumbnail;
    return thumbnail ? [thumbnail, 'thumbnails'] : null;
  }
  const image = node.lockupViewModel.contentImage?.thumbnailViewModel?.image;
  return image ? [image, 'sources'] : null;
}

/** What YouTube sent for a tile: its title, its thumbnail URL and its length in seconds. */
function readTile(node) {
  const thumb = thumbnailOf(node);
  const list = thumb ? thumb[0][thumb[1]] : null;
  return {
    original: itemTitle(node) || null,
    originalThumb: (Array.isArray(list) && list[0] && list[0].url) || null,
    duration: itemDurationSeconds(node)
  };
}

/** The item lists of a tileRenderer's metadata lines (each line's lineRenderer.items). */
function lineItemLists(node) {
  const lines = node.tileRenderer?.metadata?.tileMetadataRenderer?.lines;
  const lists = [];
  if (!Array.isArray(lines)) return lists;
  for (let i = 0; i < lines.length; i++) {
    const items = lines[i]?.lineRenderer?.items;
    if (Array.isArray(items)) lists.push(items);
  }
  return lists;
}

/** Whether a metadata line item is a badge ("4K", "HD", "CC"), not text. */
const isBadge = (item) => !!(item && item.lineItemRenderer && item.lineItemRenderer.badge);

/** Remembers the first real badge seen, without its label, as the shape of the DeArrow badge. */
function learnBadge(lists) {
  for (let i = 0; i < lists.length && !badgeLearned; i++) {
    for (let j = 0; j < lists[i].length; j++) {
      const item = lists[i][j];
      // Not a DeArrow badge of a cached response, which is already a copy.
      if (!isBadge(item) || JSON.stringify(item).indexOf(BADGE_MARK) !== -1) continue;
      badgeTemplate = JSON.parse(JSON.stringify(item.lineItemRenderer.badge));
      badgeLearned = true;
      break;
    }
  }
}

/**
 * A DeArrow badge for a metadata line: the learned badge with BADGE_MARK as
 * its label, which the sweep (sweep.js) draws as the DeArrow logo.
 */
function makeBadge() {
  const badge = JSON.parse(JSON.stringify(badgeTemplate));
  const renderer = badge.metadataBadgeRenderer || badge[Object.keys(badge)[0]] || badge;
  renderer.label = BADGE_MARK;
  delete renderer.icon;
  if (renderer.accessibilityData) {
    renderer.accessibilityData = { accessibilityData: { label: 'DeArrow' } };
  }
  return { lineItemRenderer: { badge } };
}

/**
 * Where the DeArrow badge goes: after the last badge of the line that has
 * one (next to "4K"), else at the start of the last line (the one with the
 * views and the age). Returns [items, index], or null for a tile without lines.
 */
function badgeSlot(lists) {
  for (let i = 0; i < lists.length; i++) {
    let last = -1;
    for (let j = 0; j < lists[i].length; j++) if (isBadge(lists[i][j])) last = j;
    if (last !== -1) return [lists[i], last + 1];
  }
  return lists.length ? [lists[lists.length - 1], 0] : null;
}

/** The record of what YouTube had in a tile, made the first time DeArrow writes to it. */
function originalOf(node) {
  let rec = originals.get(node);
  if (rec) return rec;
  const title = titleOf(node);
  const thumb = thumbnailOf(node);
  rec = {
    title,
    simpleText: title ? title.simpleText : undefined,
    runs: title ? title.runs : undefined,
    content: title ? title.content : undefined,
    thumbnail: thumb ? thumb[0] : null,
    listKey: thumb ? thumb[1] : null,
    thumbnails: thumb ? thumb[0][thumb[1]] : null,
    items: null,
    badge: null
  };
  originals.set(node, rec);
  return rec;
}

/** Puts YouTube's own title back into a tile. */
function restoreTitle(rec) {
  const title = rec.title;
  if (!title) return;
  if (rec.content !== undefined) {
    title.content = rec.content;
    return;
  }
  if (rec.simpleText === undefined) delete title.simpleText;
  else title.simpleText = rec.simpleText;
  if (rec.runs) title.runs = rec.runs;
}

/** Writes `text` as a tile's title, in the field its shape draws. */
function writeTitle(rec, text) {
  if (rec.content !== undefined) {
    rec.title.content = text;
    return;
  }
  rec.title.simpleText = text;
  delete rec.title.runs;
}

/** Takes the DeArrow badge back out of its metadata line. */
function removeBadge(rec) {
  if (!rec.badge) return;
  const at = rec.items.indexOf(rec.badge);
  if (at !== -1) rec.items.splice(at, 1);
  rec.items = null;
  rec.badge = null;
}

/**
 * Writes what is decided for `video` into a tile of a response: its title and
 * thumbnail (YouTube's own where nothing is), and the badge while either is a
 * crowdsourced one and the badge setting is on.
 */
function applyToTile(node, video) {
  const rec = originalOf(node);
  if (rec.title) {
    if (video.title) {
      writeTitle(rec, video.title);
      video.shownTitle = video.title;
    } else {
      restoreTitle(rec);
    }
  }
  if (rec.thumbnail) {
    if (video.thumb) {
      rec.thumbnail[rec.listKey] = [{ url: video.thumb, width: 1280, height: 720 }];
      video.shownThumb = video.thumb;
    } else {
      rec.thumbnail[rec.listKey] = rec.thumbnails;
    }
  }
  // Only for what the community submitted: with the Random frame fallback
  // nearly every thumbnail changes, and a badge on every tile tells nothing.
  const wantBadge =
    !!((video.title && video.crowdTitle) || (video.thumb && video.crowdThumb)) &&
    !!configRead('dearrowShowBadge');
  if (wantBadge && !rec.badge) {
    const slot = badgeSlot(lineItemLists(node));
    if (slot) {
      rec.items = slot[0];
      rec.badge = makeBadge();
      rec.items.splice(slot[1], 0, rec.badge);
    }
  } else if (!wantBadge) {
    removeBadge(rec);
  }
}

/** Writes what is now decided for `video` into every tile of it remembered from the responses. */
export function applyToVideo(video) {
  if (!video.tiles) return;
  for (let i = 0; i < video.tiles.length; i++) applyToTile(video.tiles[i], video);
}

/** Puts YouTube's own titles, thumbnails and lines back into every stored response edited. */
export function unpatchResponses() {
  videos.forEach((video) => {
    if (!video.tiles) return;
    for (let i = 0; i < video.tiles.length; i++) {
      const node = video.tiles[i];
      const rec = originals.get(node);
      if (!rec) continue;
      restoreTitle(rec);
      if (rec.thumbnail) rec.thumbnail[rec.listKey] = rec.thumbnails;
      removeBadge(rec);
      originals.delete(node);
    }
  });
}

/** Remembers a tile as one of `video`'s (the last TILES_PER_VIDEO of them). */
function remember(video, node) {
  if (!video.tiles) video.tiles = [];
  if (video.tiles.indexOf(node) !== -1) return;
  if (video.tiles.push(node) > TILES_PER_VIDEO) {
    // An older cached page may keep a DeArrow title until YouTube asks for it again.
    video.tiles.shift();
  }
}

/**
 * Walks a parsed response breadth first (so videos come in screen order),
 * bounded by SCAN_MAX_NODES and SCAN_MAX_DEPTH: each video tile is
 * remembered, and written to when its video is decided. Returns the ids of
 * the videos to look up: the ones seen for the first time, and the ones whose
 * lookup failed (`wantsLookup`, from lookup.js).
 */
export function patchResponseTiles(data, wantsLookup) {
  const found = [];
  const nodes = [data, 0];
  let index = 0;
  while (index < nodes.length && index < SCAN_MAX_NODES * 2) {
    const node = nodes[index++];
    const depth = nodes[index++];
    if (depth > SCAN_MAX_DEPTH) continue;

    if (node.tileRenderer || node.lockupViewModel) {
      const videoId = videoIdOf(node);
      if (videoId) {
        if (!badgeLearned && node.tileRenderer) learnBadge(lineItemLists(node));
        let video = videos.get(videoId);
        if (!video) {
          const info = readTile(node);
          video = {
            original: info.original,
            originalThumb: info.originalThumb,
            duration: info.duration,
            prefix: null,
            raw: null,
            fetched: false,
            queued: false,
            looking: false,
            retryAt: 0,
            randomInfo: null,
            title: null,
            thumb: null,
            resolved: false,
            shownTitle: null,
            shownThumb: null,
            crowdTitle: false,
            crowdThumb: false,
            tiles: null
          };
          videos.set(videoId, video);
          found.push(videoId);
        } else if (wantsLookup(video)) {
          found.push(videoId);
        }
        remember(video, node);
        if (video.resolved) applyToTile(node, video);
        continue;
      }
    }

    for (const key in node) {
      if (SKIP_KEYS[key]) continue;
      const value = node[key];
      if (value && typeof value === 'object') nodes.push(value, depth + 1);
    }
  }
  return found;
}
