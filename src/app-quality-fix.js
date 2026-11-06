import { configRead, configAddChangeListener } from './config.js';

/**
 * Remove Black Text Boxes (UI Tweaks, on by default).
 *
 * When YouTube's server sends the TV `force_memory_saving_mode` (it shows in
 * window.environment.flags), YouTube puts `app-quality-root` on <body>, and its
 * own stylesheet then draws solid black boxes behind the player's title, the
 * channel line and the timestamps instead of the soft text shadow. The flag is
 * the server's, so it can come months after install and stays after a
 * reinstall. Seen on an LG C2 (webOS 22); from NicholasBly/youtube-webos#215.
 *
 * Taking the class off <body> brings back the normal styling. Only the CSS
 * changes: the rest of YouTube's memory saving is decided in its own code and
 * stays as it is. YouTube rewrites body.className on navigation, so an observer
 * on <body>'s class attribute takes it off again each time. Turned off, the
 * class goes back if YouTube had put it there, and Fix Multiline Titles and New
 * Liquid Glass UI style the boxes again as before.
 *
 * webosbrew's ui.js did the same from 2024 (applyUIFixes, after TizenTube);
 * NicholasBly's 0.4.9 commented its call out and 0.6.1 removed it.
 */

const QUALITY_CLASS = 'app-quality-root';
const CONFIG_KEY = 'removeLowMemoryStyle';
// How long to wait for <body> at most: 300 x 100 ms.
const BODY_WAIT_MS = 100;
const BODY_WAIT_TRIES = 300;

let observer = null;
let waitTimer = null;
// Whether YouTube had the class when it was taken off, so that turning the
// setting off can give it back.
let stripped = false;

/** Takes the class off <body> if YouTube has put it there. */
function strip() {
  const body = document.body;
  if (!body || !body.classList.contains(QUALITY_CLASS)) return;
  body.classList.remove(QUALITY_CLASS);
  stripped = true;
}

/** Strips the class and watches <body> for it; false while there is no <body> yet. */
function start() {
  if (!document.body) return false;
  if (observer) return true;
  strip();
  observer = new MutationObserver(strip);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return true;
}

function stopWaiting() {
  if (!waitTimer) return;
  clearInterval(waitTimer);
  waitTimer = null;
}

/** Stops watching and gives YouTube its class back if it had it. */
function stop() {
  stopWaiting();
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (stripped && document.body) document.body.classList.add(QUALITY_CLASS);
  stripped = false;
}

/** Follows the setting: on starts the watch (waiting for <body> if needed), off stops it. */
function sync() {
  if (!configRead(CONFIG_KEY)) {
    stop();
    return;
  }
  if (start() || waitTimer) return;
  let tries = 0;
  waitTimer = setInterval(() => {
    if (start() || ++tries >= BODY_WAIT_TRIES) stopWaiting();
  }, BODY_WAIT_MS);
}

sync();
configAddChangeListener(CONFIG_KEY, sync);
