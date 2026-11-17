/**
 * Show Watch Time With the Clock (watch-time.js, watch.js): the clock reads
 * "<time> · 1h 05m watched", where only playback on the watch and Shorts
 * pages counts - not pauses, buffering or previews on the browse pages - and
 * the panel row is off while the clock is.
 *
 * Usage: node bench/watch-time-test.cjs [dist/webOSUserScripts/userScript.js] [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, wait: sleep } = require('./harness.cjs');

const GREEN = 404;
const MIN = 60000;

// The page's clock: real time plus an offset the cases move forward.
let offset = 0;

const { win, doc, errors } = bootPage({
  bodyClass: 'WEB_PAGE_TYPE_WATCH',
  inner: '<video></video>',
  raf: 'timer',
  config: {
    enableAdBlock: false, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, thumbnailQuality: 'off', enableAutoLogin: false,
    clockMode: 'time', showWatchTime: true
  },
  consoleErrors: false,
  // The legacy environment has no Element#remove here.
  restoreRemove: false,
  setup: (w) => {
    const RealDate = w.Date;
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset); }
      static now() { return RealDate.now() + offset; }
    }
    w.Date = FakeDate;
  }
});

const { t, run } = createReporter();

const key = (code) => trustedKey(win, code);
// The panel row of a setting, found by its label.
function row(label) {
  return [...doc.querySelectorAll('.ytaf-ui-container label')].find((l) => l.textContent.trim() === label);
}
function toggle(label) {
  const input = row(label).querySelector('input');
  input.checked = !input.checked;
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
}
const clockText = () => (doc.querySelector('.webOs-watch') || {}).textContent || '';
// Switching the setting off and on again redraws the clock now, not at the minute.
function refresh() {
  toggle('Show Watch Time With the Clock');
  toggle('Show Watch Time With the Clock');
  return clockText();
}
const fire = (el, type) => el.dispatchEvent(new win.Event(type));

run(async () => {
  await sleep(300);
  key(GREEN);
  await sleep(100);
  const video = doc.querySelector('video');
  Object.defineProperty(video, 'paused', { get: () => false, configurable: true });

  t('panel has the row', !!row('Show Watch Time With the Clock'));
  t('clock starts at 0m', / · 0m watched$/.test(clockText()), JSON.stringify(clockText()));

  fire(video, 'playing');
  offset += 5 * MIN + 1000;
  t('5 minutes of playback count', / · 5m watched$/.test(refresh()), JSON.stringify(clockText()));

  fire(video, 'pause');
  offset += 10 * MIN;
  t('a pause does not count', / · 5m watched$/.test(refresh()), JSON.stringify(clockText()));

  fire(video, 'playing');
  offset += 61 * MIN;
  t('past an hour: "1h 06m"', / · 1h 06m watched$/.test(refresh()), JSON.stringify(clockText()));

  fire(video, 'waiting');
  offset += 5 * MIN;
  t('buffering does not count', / · 1h 06m watched$/.test(refresh()), JSON.stringify(clockText()));

  // A preview on a browse page plays a <video> too.
  doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
  await sleep(50);
  fire(video, 'playing');
  offset += 5 * MIN;
  t('a preview on a browse page does not count', / · 1h 06m watched$/.test(refresh()), JSON.stringify(clockText()));

  // Back to a video that already plays: counting picks up with the page.
  doc.body.className = 'WEB_PAGE_TYPE_WATCH';
  await sleep(50);
  offset += 2 * MIN;
  t('a video already playing when the watch page shows counts', / · 1h 08m watched$/.test(refresh()), JSON.stringify(clockText()));

  // In the background, then back with the video still playing (no 'playing').
  let hidden = false;
  Object.defineProperty(doc, 'hidden', { get: () => hidden, configurable: true });
  hidden = true;
  doc.dispatchEvent(new win.Event('visibilitychange'));
  offset += 3 * MIN;
  hidden = false;
  doc.dispatchEvent(new win.Event('visibilitychange'));
  offset += 4 * MIN;
  t('the background does not count, playing on after it does', / · 1h 12m watched$/.test(refresh()), JSON.stringify(clockText()));

  toggle('Show Watch Time With the Clock');
  t('switched off: the time alone', !/watched/.test(clockText()) && clockText().length > 0, JSON.stringify(clockText()));

  t('row enabled while the clock is on', !row('Show Watch Time With the Clock').querySelector('input').disabled);

  t('no page errors', errors.length === 0, errors.join(' | '));
});
