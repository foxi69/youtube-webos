/**
 * Show Video Quality, Under Title and Both (quality-tag.js): a stylesheet
 * rule puts the quality the video plays in after the metadata line under the
 * title, follows the picture when the stream switches quality, and is
 * cleared off the watch page and on Off and At Start. The stored setting is
 * Show Video Quality on Under Title.
 *
 * Usage: node bench/quality-tag-test.cjs <bundle> [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, wait } = require('./harness.cjs');

const GREEN = 404;

const { t, run } = createReporter();

// The bundle on the watch page, of the build the command line names (the
// modern one in a Chrome 87 environment with a webOS 23 user agent, the
// legacy one in a Chrome 38 one). Page script errors go to `errors`.
const { win, doc, errors } = bootPage({
  bodyClass: 'WEB_PAGE_TYPE_WATCH',
  inner: '<video></video>',
  consoleErrors: false,
  restoreRemove: false,
  raf: 'timer',
  config: {
    enableAdBlock: false, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, thumbnailQuality: 'off', enableAutoLogin: false,
    showVideoQuality: 'title'
  }
});

/** One step of the Show Video Quality row on the panel; its value after it. */
function step() {
  const row = [...doc.querySelectorAll('.ytaf-ui-container .shortcut-control-row')]
    .find((r) => (r.querySelector('.shortcut-label') || {}).textContent === 'Show Video Quality');
  row.click();
  return row.querySelector('.current-value').textContent;
}
const rule = () => (doc.getElementById('ytaf-quality-tag') || {}).textContent || '';
const video = doc.querySelector('video');
let size = [0, 0];
Object.defineProperty(video, 'videoWidth', { get: () => size[0] });
Object.defineProperty(video, 'videoHeight', { get: () => size[1] });
// The picture changing size, as the adaptive stream switching quality does.
function picture(w, h) {
  size = [w, h];
  video.dispatchEvent(new win.Event('resize'));
}

run(async () => {
  await wait(300);
  t('nothing before the picture is known', rule() === '', rule());

  picture(1920, 1080);
  t('1080p after the metadata line', /ytlr-video-metadata-line::after/.test(rule()) && /content:"1080p"/.test(rule()), rule());

  picture(3840, 2160);
  t('follows a switch to 2160p', /content:"2160p"/.test(rule()), rule());

  picture(1080, 1920);
  t('a portrait video reads by its shorter side', /content:"1080p"/.test(rule()), rule());

  doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
  await wait(50);
  t('cleared off the watch page', rule() === '', rule());

  doc.body.className = 'WEB_PAGE_TYPE_WATCH';
  await wait(50);
  t('back on the watch page', /content:"1080p"/.test(rule()), rule());

  trustedKey(win, GREEN);
  await wait(100);
  let value = step();
  t('Both: the tag stays', value === 'Both' && /content:"1080p"/.test(rule()), `${value} ${rule()}`);
  value = step();
  t('Off: cleared', value === 'Off' && rule() === '', `${value} ${rule()}`);
  value = step();
  t('At Start: no tag', value === 'At Start' && rule() === '', `${value} ${rule()}`);
  value = step();
  t('Under Title: shown again', value === 'Under Title' && /content:"1080p"/.test(rule()), `${value} ${rule()}`);

  t('no page errors', errors.length === 0, errors.join(' | '));
});
