// Dev diagnostics, aliased to an empty module unless built with `--env perf`.
// MUST stay first: perf_mon installs "inner" probes underneath every other hook.
import './perf_mon.js';

// polyfills.js before whatwg-fetch: the fetch polyfill decides at load time
// whether URLSearchParams exists, and on webOS 3 a URLSearchParams body was
// otherwise sent as "[object Object]".
import './polyfills.js';
import 'whatwg-fetch';
import './playback-speed.js';
import './adblock.js';
import './hooks/json-stringify';
import './force-codec.js';
import './subtitle-translate.js';
import './early-browse.js';

import { SELECTORS } from './utils';
import { configRead } from './config.js';
import { handleLaunch, extractLaunchParams } from './launch.js';
import { attemptActiveBypass, resetActiveBypass } from './auto-login.js';
import { getWebOSVersion, isWebOS25, simulatorMode } from './webos-utils.js';
import { initBlockWebOSCast } from './block-webos-cast';
import './app_api/index';
import './ui.js'; // Registers the green-key handler, options panel, video-quality, global styles
import './keyboard-search.js';
import './sponsorblock.js';
import './emoji-font.js';
import './screensaver-fix.js';
import './yt-fixes.css';
import './app-quality-fix.js';
import './comments-fix.js';
import './watch.js';
import './mute-previews.js';
import './guide-fit.js';
import './start-page.js';
import './time-remaining.js';
import './most-replayed.js';
import './quality-tag.js';
import './lang-settings-fix';
import { initAiContentFilter } from './ai-content-filter.js';

import { initBufferLimit } from './hooks/buffer-limit.js';
import { initPreviewFix } from './preview-fix.js';
import { initAbout } from './about.js';

// Disable Animations also leaves out YouTube's full navigation animations,
// which the launch address asks for (env_forceFullAnimation, launch.js).
// YouTube reads the address as it starts, after this script, so taking the
// flag off it is enough; a change applies from the next start. (After
// stanbrown, NicholasBly/youtube-webos#217.)
if (configRead('disableAnimations')) {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('env_forceFullAnimation')) {
      url.searchParams.delete('env_forceFullAnimation');
      window.history.replaceState(window.history.state, '', url.toString());
    }
  } catch {
    // An address that cannot be rewritten keeps the animations.
  }
}

initPreviewFix();
initAbout();

if (typeof initBufferLimit === 'function' && getWebOSVersion() <= 4) {
	initBufferLimit();
	console.info('Initiating buffer limit');
}

(function oneTimeParamsCheck() {
    const params = extractLaunchParams();
    if (params && Object.keys(params).length > 0) {
        attemptActiveBypass();
    }
})();

document.addEventListener(
  'webOSRelaunch',
  (evt) => {
    // Only the names, as handleLaunch logs them.
    console.info('RELAUNCH:', evt.detail && typeof evt.detail === 'object' ? Object.keys(evt.detail) : typeof evt.detail);
	resetActiveBypass();
    if (document.body && document.body.classList.contains(SELECTORS.ACCOUNT_SELECTOR)) {
        console.info('[Main] Relaunch detected on Account Selector. Triggering bypass.');
        attemptActiveBypass(true);
    }
    // A plain relaunch (the app icon, `ares-launch`) brings only
    // displayAffinity: the app stays where it is instead of reloading Home.
    const detail = evt.detail;
    if (detail && typeof detail === 'object' && (detail.target || detail.contentTarget)) handleLaunch(detail);
  },
  true
);

if (isWebOS25() && simulatorMode === false) {
  console.info('[Main] Enabling webOS Google Cast Block');
  initBlockWebOSCast();
}

initAiContentFilter();
