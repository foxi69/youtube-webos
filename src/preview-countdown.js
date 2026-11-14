import { isWatchPage, isShortsPage, SELECTORS } from './utils.js';

/**
 * Preview countdown: while a tile's preview plays, the time on the tile
 * counts down to the end of the video, as on YouTube's web pages. YouTube TV
 * leaves it at the full length. The tile's own text is written back when the
 * preview stops, the focus moves on or a watch page opens.
 *
 * Only the focused tile whose video is the one playing is touched, and only a
 * time it shows ("2:49", "1:02:03"): a live badge or any other text stays.
 */

const TIME_RE = /^\d+(?::\d\d){1,2}$/;
const TILE = 'ytlr-tile-renderer';
const BADGE = 'ytlr-thumbnail-overlay-time-status-renderer yt-formatted-string';

// The badge being counted down and the text it had.
let current = null;

function format(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s % 60);
}

function restore() {
  if (!current) return;
  if (current.badge.textContent === current.shown) current.badge.textContent = current.text;
  current = null;
}

function tileVideoId(tile) {
  try {
    return tile.__instance.props.data.contentId || null;
  } catch {
    return null;
  }
}

function playingVideoId(player) {
  try {
    const data = player.getVideoData();
    return (data && !data.isLive && data.video_id) || null;
  } catch {
    return null;
  }
}

function onTimeUpdate(evt) {
  const video = evt.target;
  if (!(video instanceof HTMLVideoElement)) return;
  if (isWatchPage() || isShortsPage() || video.paused) {
    restore();
    return;
  }
  const focused = document.activeElement;
  const tile = focused && focused.closest ? focused.closest(TILE) : null;
  const player = document.getElementById(SELECTORS.PLAYER_ID);
  const id = player ? playingVideoId(player) : null;
  if (!tile || !id || tileVideoId(tile) !== id) {
    restore();
    return;
  }
  const badge = tile.querySelector(BADGE);
  if (!badge) {
    restore();
    return;
  }
  // YouTube wrote the badge anew while it counted down: that text is the
  // tile's own from now on, and is what comes back when the preview stops.
  if (current && current.badge === badge && current.shown !== null && badge.textContent !== current.shown) {
    current = null;
  }
  if (!current || current.badge !== badge) {
    restore();
    const text = (badge.textContent || '').trim();
    if (!TIME_RE.test(text)) return;
    current = { badge, text, shown: null };
  }
  let duration = NaN;
  try {
    duration = player.getDuration();
  } catch {
    // The video's own duration below.
  }
  if (!(duration > 0)) duration = video.duration;
  if (!(duration > 0) || !isFinite(duration)) return;
  const shown = format(duration - video.currentTime);
  if (current.badge.textContent !== shown) current.badge.textContent = shown;
  current.shown = shown;
}

// Capture: media events do not bubble.
document.addEventListener('timeupdate', onTimeUpdate, true);
for (const type of ['pause', 'ended', 'emptied']) document.addEventListener(type, restore, true);
document.addEventListener('focusin', () => {
  if (!current) return;
  const focused = document.activeElement;
  if (!focused || !focused.closest || focused.closest(TILE) !== current.badge.closest(TILE)) restore();
}, true);
window.addEventListener('ytaf-page-update', restore);
