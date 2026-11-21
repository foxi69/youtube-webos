/**
 * Settings that only act while another is on are greyed out in the panel and
 * follow it when it changes: Auto Login under Bypass Nag Screens
 * (auto-login.js reads both), Video shelf opacity under OLED-Care Mode (its
 * rule is gated by html.oled-theme-active).
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
  t(n('no page errors'), errors.length === 0, errors.join(' | '));
});
