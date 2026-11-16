/**
 * Loads the MODERN bundle in a webOS 23-shaped window and asserts it survives
 * evaluation and the settings panel opens.
 *
 * This exists because the suite only ever smoke-tested the legacy bundle, and a
 * modern-only crash shipped once ("Cannot add property trackFocus, object is
 * not extensible", from the spatial-navigation shim that 0.8.6 removed).
 *
 * No Chromium 38 downgrade here - the point is to exercise the code paths that
 * ONLY run on a modern engine (no polyfills.js, no emoji-font.js, no
 * buffer-limit). It runs in a Chrome 87 environment, webOS 22's engine.
 */
const { createReporter, readBundle, bootPage, trustedKey } = require('./harness.cjs');

// Always the modern build's page: webOS 23 (the modern code paths) in Chrome
// 87, the oldest engine that build serves.
const { win, errors, threw } = bootPage({
  modern: true,
  inner: '\n     <div id="ytlr-player__player-container"><video></video></div>\n   ',
  errorStacks: true,
  webOS: true,
  restoreRemove: false,
  catchThrow: true
});

const { t, done } = createReporter();

setTimeout(() => {
  t('modern bundle loads without throwing', !threw,
    threw && (threw.message + ' | ' + (threw.stack || '').split('\n')[1]));
  t('no "not extensible" error', !(threw && /not extensible/.test(threw.message)), threw && threw.message);
  t('no jsdomError during load', errors.length === 0, errors[0]);
  t('JSON.parse hooked', win.JSON.parse.toString().indexOf('native code') === -1);
  t('JSON.stringify hooked', win.JSON.stringify.toString().indexOf('native code') === -1);
  t('no spatial-navigation shim shipped', !win.__spatialNavigation__);

  // The green key opens the settings panel, which moves focus by itself.
  let keyThrew = null;
  try { trustedKey(win, 404); } catch (e) { keyThrew = e; }
  t('green key opens the settings panel without throwing',
    !keyThrew && !!win.document.querySelector('.ytaf-ui-container'), keyThrew && keyThrew.message);
  t('no error while opening the panel', errors.length === 0, errors[0]);

  // The legacy-only modules must be aliased out of this build.
  const src = readBundle();
  t('polyfills.js excluded from modern build', src.indexOf('Array.from requires an array-like') === -1);
  t('no bare require() in modern bundle', !/(?:^|[^.\w$])require\s*\(/.test(src));

  done();
}, 600);
