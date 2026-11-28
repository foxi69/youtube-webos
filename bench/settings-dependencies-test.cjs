/**
 * Settings that only act while another is on are greyed out in the panel and
 * follow it when it changes: Auto Login under Bypass Nag Screens
 * (auto-login.js reads both), Video shelf opacity under OLED-Care Mode (its
 * rule is gated by html.oled-theme-active), and Ad Blocking's rows, which say
 * "(needs Ad Blocking)" while it is off. Also the order of the Player page's
 * subtitle rows and their descriptions.
 *
 *   node bench/settings-dependencies-test.cjs <bundle> [legacy|modern]
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, trustedKey, wait } = require('./harness.cjs');

const { modern } = flavorFromArgs();
const code = readBundle();
const GREEN = 404;
const { t, run } = createReporter();

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;
  const { win, errors } = bootPage({
    code,
    bodyClass: 'WEB_PAGE_TYPE_BROWSE',
    config: {
      enableAdBlock: true, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false, autoSelectAccount: true,
      enableOledCareMode: false, checkForUpdates: false, showWhatsNew: false, enableLegacyEmojiFix: false
    },
    fetch: 'pending'
  });
  await wait(20);
  trustedKey(win, GREEN);
  // The UI Tweaks page is built in a frame after the panel opens: waited for
  // (a busy machine runs that frame late).
  for (let i = 0; i < 60 && !win.document.getElementById('ytaf-page-ui-tweaks'); i++) await wait(50);
  await wait(50);

  const box = (start) => {
    const label = [...win.document.querySelectorAll('.ytaf-ui-container label')]
      .find((l) => l.textContent.trim().startsWith(start));
    return label && label.querySelector('input[type=checkbox]');
  };
  const set = (start, on) => {
    const b = box(start);
    b.checked = on;
    b.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  const shelfRow = () => {
    const label = [...win.document.querySelectorAll('.ytaf-ui-container .shortcut-label')]
      .find((l) => l.textContent.trim() === 'Video shelf opacity');
    return label && label.closest('.shortcut-control-row');
  };

  t(n('the panel has Auto Login and Bypass Nag Screens'), !!box('Auto Login') && !!box('Bypass Nag Screens'));
  t(n('Bypass Nag Screens off: Auto Login greyed out'), box('Auto Login').disabled === true);
  set('Bypass Nag Screens', true);
  await wait(20);
  t(n('Bypass Nag Screens on: Auto Login usable'), box('Auto Login').disabled === false);
  set('Bypass Nag Screens', false);
  await wait(20);
  t(n('off again: greyed out again'), box('Auto Login').disabled === true);

  const row = shelfRow();
  t(n('the panel has the Video shelf opacity row'), !!row);
  t(n('OLED-Care Mode off: the shelf row is greyed out and out of the focus order'),
    row.style.opacity === '0.5' && row.tabIndex === -1, row.style.opacity + ' ' + row.tabIndex);
  set('OLED-Care Mode', true);
  await wait(20);
  t(n('OLED-Care Mode on: the shelf row is usable'), row.style.opacity === '1' && row.tabIndex === 0, row.style.opacity + ' ' + row.tabIndex);
  set('OLED-Care Mode', false);
  await wait(20);
  t(n('off again: greyed out again'), row.style.opacity === '0.5' && row.tabIndex === -1);

  // Ad Blocking's dependents: with it off, greyed out and labelled so, their own value kept.
  const labelOf = (start) => {
    const l = [...win.document.querySelectorAll('.ytaf-ui-container label')].find((el) => el.textContent.trim().startsWith(start));
    return l && l.textContent.trim();
  };
  const feedTitle = () => {
    const el = [...win.document.querySelectorAll('.ytaf-ui-container .section-title')].find((e) => e.textContent.startsWith('Feed Filters'));
    return el && el.textContent;
  };
  for (let i = 0; i < 60 && !feedTitle(); i++) await wait(50);
  set('Reduce Telemetry', true);
  t(n('Ad Blocking on: the dependents have their own labels'),
    labelOf('Reduce Telemetry') === 'Reduce Telemetry & Tracking' && labelOf('Remove Shorts') === 'Remove Shorts (Global)' &&
    feedTitle() === 'Feed Filters', `${labelOf('Reduce Telemetry')} | ${feedTitle()}`);
  set('Ad Blocking', false);
  await wait(20);
  t(n('Ad Blocking off: each dependent row and the Feed Filters title say they need it'),
    labelOf('Reduce Telemetry') === 'Reduce Telemetry & Tracking (needs Ad Blocking)' &&
    labelOf('Hide Recommended') === 'Hide Recommended Videos Under the Player (needs Ad Blocking)' &&
    feedTitle() === 'Feed Filters (needs Ad Blocking)', `${labelOf('Reduce Telemetry')} | ${labelOf('Hide Recommended')} | ${feedTitle()}`);
  t(n('Ad Blocking off: a ticked dependent stays ticked (greyed out)'),
    box('Reduce Telemetry').checked === true && box('Reduce Telemetry').disabled === true);
  set('Ad Blocking', true);
  await wait(20);
  t(n('Ad Blocking on again: the labels are back, the box still ticked'),
    labelOf('Reduce Telemetry') === 'Reduce Telemetry & Tracking' && feedTitle() === 'Feed Filters' &&
    box('Reduce Telemetry').checked === true && box('Reduce Telemetry').disabled === false, `${labelOf('Reduce Telemetry')} | ${feedTitle()}`);
  // Subtitle Position's description right under its own row (it was under Subtitle Delay's).
  const playerRows = [...win.document.querySelectorAll('.ytaf-ui-container *')]
    .map((e) => e.children.length === 0 ? e.textContent.trim() : '').filter((s) => /^(?:Subtitle Position|Subtitle Delay|Lifts the subtitles|For subtitles out of step)/.test(s))
    .map((s) => s.split(/[ ,.]/).slice(0, 2).join(' '));
  t(n('Player page: each subtitle row has its own description under it'),
    JSON.stringify(playerRows) === JSON.stringify(['Subtitle Position', 'Lifts the', 'Subtitle Delay', 'For subtitles']), JSON.stringify(playerRows));
  t(n('no page errors'), errors.length === 0, errors.join(' | '));
});
