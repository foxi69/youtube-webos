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
// The queued video whose command still waits for the TV app's resolver (only
// while it is being looked for; once found, the command goes at once).
let dispatching = null;

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

/** The queued videos, next first: [{ videoId, title }] (a copy). */
export function queuedVideos() {
  return queue.map((item) => ({ videoId: item.videoId, title: item.title }));
}

export function clearQueue() {
  queue.length = 0;
  // A video whose command still waits goes too: it is neither sent late nor
  // put back. One already sent plays on.
  if (dispatching) {
    if (opening === dispatching) opening = null;
    dispatching = null;
  }
  showNotification('Queue cleared');
}

/** The video the watch page's address names, or null away from it. */
function watchedId() {
  const m = /^#\/watch\?(?:[^#]*&)?v=([^&]+)/.exec(window.location.hash);
  return m ? m[1] : null;
}

/**
 * Another video on the watch page than the attempt's own and the one that was
 * on when it began: the viewer chose it.
 */
function choseAnother(attempt) {
  const shown = watchedId();
  return !!shown && shown !== attempt.videoId && shown !== attempt.from;
}

/** The attempt's video goes back to the front, and plays at the next end. */
function putBack(attempt) {
  queue.unshift(attempt);
  if (opening === attempt) opening = null;
  dispatching = null;
}

/** Plays the next queued video; false when the queue is empty. */
function playNext() {
  // A video whose command still waits is not lost to a second call (an end
  // meanwhile): it goes first, in a new attempt.
  if (dispatching) queue.unshift(dispatching);
  const item = queue.shift();
  if (!item) return false;
  // Each attempt is its own object, so a late answer to an earlier attempt for
  // the same video finds it no longer current and leaves this one alone.
  // `from`: the video the watch page showed when this attempt began.
  const next = { videoId: item.videoId, title: item.title, from: watchedId() };
  clearTimeout(refusalTimer);
  opening = next;
  showNotification(`Next in queue: ${next.title} (${queue.length} left)`);
  // YouTube's own command: a new address alone loses to the step back to Home
  // that YouTube takes right after a video ends.
  dispatching = next;
  ResolveCommandRegistry.getInstance()
    .then(
      (registry) => {
        // The viewer started another video meanwhile (see the state listener).
        if (dispatching !== next) return;
        // Or chose one that is still loading and has not reported PLAYING.
        if (choseAnother(next)) { putBack(next); return; }
        dispatching = null;
        registry.dispatchCommand({ watchEndpoint: { videoId: next.videoId } });
      },
      (err) => {
        // A failed lookup: told only while this attempt is still the current
        // one (not after a newer attempt or a cleared queue took over).
        if (dispatching !== next) return;
        dispatching = null;
        throw err;
      }
    )
    .catch((err) => {
      console.warn('[Queue] Could not play the next video:', err);
      if (opening === next) opening = null;
      showNotification(`Could not play: ${next.title}`);
    });
  return true;
}

export function playNextInQueue() {
  // Next pressed again while the next video's command waits: it is on its way.
  if (dispatching) {
    showNotification(`On its way: ${dispatching.title}`);
    return;
  }
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
  if (!detail) return;
  // Another video playing on the watch page while the queued one's command
  // still waits: the viewer chose it. The queued video goes back to the front
  // and plays at the next end instead. Told by the address, not the event's
  // id: the video that was on when the attempt began may report PLAYING again
  // (after buffering, or still playing when Queue Next was pressed), and an
  // event may name no video.
  if (detail.state === 1 && dispatching && choseAnother(dispatching)) putBack(dispatching);
  if (detail.state === 1 && opening && detail.videoId === opening.videoId) {
    opening = null;
    clearTimeout(refusalTimer);
  }
  // A queued video the viewer opened from the Queue row (or anywhere): it has
  // had its turn, and is not played again at the next end. On the watch page
  // only: its preview playing behind the home screen is no turn.
  if (detail.state === 1 && detail.videoId && watchedId() === detail.videoId) {
    const index = queue.findIndex((item) => item.videoId === detail.videoId);
    if (index !== -1) queue.splice(index, 1);
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
