/**
 * A play queue: videos added from the long-press menu play one after another
 * when the current video ends, before YouTube's autoplay does. It lasts until
 * the app closes.
 *
 * The idea is from MickLesk's fork (src/video-queue.ts).
 */
import { showNotification } from './notifications.js';
import { ResolveCommandRegistry } from './app_api/index';

const queue = [];
// A video can report its end more than once.
let endHandled = false;

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
  showNotification(`Next in queue: ${next.title} (${queue.length} left)`);
  // YouTube's own command: a new address alone loses to the step back to Home
  // that YouTube takes right after a video ends.
  ResolveCommandRegistry.getInstance()
    .then((registry) => registry.dispatchCommand({ watchEndpoint: { videoId: next.videoId } }))
    .catch((err) => {
      console.warn('[Queue] Could not play the next video:', err);
      showNotification(`Could not play: ${next.title}`);
    });
  return true;
}

export function playNextInQueue() {
  if (!playNext()) showNotification('The queue is empty');
}

window.addEventListener('yt-player-state-change', ({ detail }) => {
  if (detail.state !== 0) {
    endHandled = false;
    return;
  }
  // Previews behind the home screen end too.
  if (endHandled || !queue.length || !window.location.hash.startsWith('#/watch')) return;
  endHandled = true;
  playNext();
});
