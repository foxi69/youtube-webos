/**
 * A play queue: videos added from the long-press menu play one after another
 * when the current video ends, before YouTube's autoplay does. It lasts until
 * the app closes.
 *
 * The idea is from MickLesk's fork (src/video-queue.ts).
 */
import { showNotification } from './notifications.js';
import { ResolveCommandRegistry } from './app_api/index';

// YouTube answers for a video it refuses in bursts about half a second apart,
// and each answer must be over before the next video opens: one that came late
// would count against that video.
// ponytail: a fixed wait, a burst slower than this skips a good video.
const REFUSAL_SETTLE_MS = 2000;

const queue = [];
// A video can report its end more than once.
let endHandled = false;
// The queued video on its way to the screen: { videoId, title }.
let opening = null;
let refusalTimer = null;

export function addToQueue(videoId, title) {
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].videoId === videoId) {
      showNotification('Already in the queue');
      return;
    }
  }
  queue.push({ videoId, title });
  showNotification(`Added to queue (${queue.length}): ${title}`);
}

export function clearQueue() {
  queue.length = 0;
  showNotification('Queue cleared');
}

/** Plays the next queued video; false when the queue is empty. */
function playNext() {
  const next = queue.shift();
  if (!next) return false;
  clearTimeout(refusalTimer);
  opening = next;
  showNotification(`Next in queue: ${next.title} (${queue.length} left)`);
  // YouTube's own command: a new address alone loses to the step back to Home
  // that YouTube takes right after a video ends.
  ResolveCommandRegistry.getInstance()
    .then((registry) => registry.dispatchCommand({ watchEndpoint: { videoId: next.videoId } }))
    .catch((err) => {
      console.warn('[Queue] Could not play the next video:', err);
      if (opening === next) opening = null;
      showNotification(`Could not play: ${next.title}`);
    });
  return true;
}

export function playNextInQueue() {
  if (!playNext()) showNotification('The queue is empty');
}

function skipRefused() {
  const refused = opening;
  opening = null;
  // Left for another page or video while the answers settled.
  if (!refused || !window.location.hash.includes(refused.videoId)) return;
  showNotification(`Could not play: ${refused.title}`);
  playNext();
}

/**
 * The playability status of a player response. It names no video and YouTube
 * reports no end for a refused one, so without this the queue would wait for
 * ever. Only the two statuses with no way forward: on the others (age check,
 * content warning) the viewer has something to answer.
 */
export function noteQueuePlayability(status) {
  if (!opening || (status !== 'ERROR' && status !== 'UNPLAYABLE')) return;
  clearTimeout(refusalTimer);
  refusalTimer = setTimeout(skipRefused, REFUSAL_SETTLE_MS);
}

window.addEventListener('yt-player-state-change', ({ detail }) => {
  if (detail.state === 1 && opening && detail.videoId === opening.videoId) {
    opening = null;
    clearTimeout(refusalTimer);
  }
  if (detail.state !== 0) {
    endHandled = false;
    return;
  }
  // Previews behind the home screen end too.
  if (endHandled || !queue.length || !window.location.hash.startsWith('#/watch')) return;
  endHandled = true;
  playNext();
});
