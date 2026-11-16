/**
 * Force Max Quality on webOS 25: the quality switch reloads the <video>, and
 * the reloaded element can wait at 0 while the player buffers around the
 * position it resumed from (a video opened from its home screen preview, or
 * resumed from the history). Once the element is stuck there for two checks,
 * video-quality.js seeks it back to the player's position; an element that has
 * data, and webOS 24 and older, are left alone.
 *
 * Runs on the MODERN bundle (webOS 22+ is only ever served that one).
 *
 * Usage: node bench/quality-reload-test.cjs <modern bundle>
 */
const { createReporter, readBundle, bootPage, failingXHR, wait, UA } = require('./harness.cjs');

const bundle = readBundle();

const UA25 = UA.webos23.replace('webOS.TV-2023', 'webOS.TV-2025');

const { t, run: report } = createReporter();

async function run(ua, ready, startAt) {
  // The modern bundle whatever the command line says, in the Chrome 87
  // environment (the oldest engine the modern build serves), with no network.
  const { win, frames } = bootPage({
    code: bundle,
    modern: true,
    userAgent: ua,
    html: '<body class="WEB_PAGE_TYPE_WATCH"><div id="ytlr-player__player-container-player"><video></video></div></body>',
    url: 'https://www.youtube.com/tv#/watch?v=abc',
    consoleErrors: false,
    restoreRemove: false,
    xhr: failingXHR(),
    raf: 'manual',
    config: {
      forceHighResVideo: true, enableAdBlock: false, enableSponsorBlock: false,
      enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false
    },
    fetch: () => Promise.reject(new Error('offline'))
  });
  const pump = () => frames.pump();

  const p = win.document.getElementById('ytlr-player__player-container-player');
  const v = p.querySelector('video');
  let ct = startAt;
  Object.defineProperty(v, 'currentTime', { get: () => ct, set: (x) => { ct = x; }, configurable: true });
  Object.defineProperty(v, 'readyState', { get: () => ready, configurable: true });
  Object.defineProperty(v, 'seeking', { get: () => false, configurable: true });
  let q = 'hd720';
  Object.assign(p, {
    setPlaybackQualityRange() { q = 'hd1440'; }, setPlaybackQuality() {},
    getPlaybackQuality: () => q, getPlaybackQualityLabel: () => q,
    getAvailableQualityLevels: () => ['hd1440', 'hd1080', 'hd720', 'auto'],
    getVideoData: () => ({ video_id: 'abc' }), getPlayerState: () => 1, getCurrentTime: () => 95,
    pauseVideo() {}, playVideo() {}, isInline: () => false, addEventListener() {}
  });
  win.dispatchEvent(new win.CustomEvent('yt-navigate-finish', { detail: { pageType: 'watch' } }));
  await wait(300);
  pump(); pump();
  await wait(1700);
  const upgraded = q === 'hd1440';
  win.close();
  return { ct, upgraded };
}

report(async () => {
  let r = await run(UA25, 1, 0);
  t('webOS 25, element stuck at 0 after the switch: seeked to the player position', r.upgraded && r.ct === 95, JSON.stringify(r));
  r = await run(UA25, 4, 0);
  t('webOS 25, element has data: left alone', r.upgraded && r.ct === 0, JSON.stringify(r));
  r = await run(UA25, 1, 94.5);
  t('webOS 25, element within 1 s of the player: left alone', r.upgraded && r.ct === 94.5, JSON.stringify(r));
  r = await run(UA.webos23, 1, 0);
  t('webOS 23: never touched', r.upgraded && r.ct === 0, JSON.stringify(r));
});
