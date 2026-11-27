/**
 * Fit Page Beside Menu (src/guide-fit.js): off, the guide is not measured at
 * all (the check every 2 s forced a layout each time); a guide YouTube makes
 * again takes the old one's observer with it; on, an open guide fits the page.
 * Without ResizeObserver (webOS 3 and 4) the settings panel leaves the switch
 * out.
 *
 * Usage: node bench/guide-fit-test.cjs [bundle] [legacy|modern]
 */
const { createReporter, flavorFromArgs, bootPage, trustedKey, wait, until, UA } = require('./harness.cjs');

const GREEN = 404;

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment.
// The legacy one runs with no environment applied (see boot); the user agent
// is webOS 23 on both.
const { modern } = flavorFromArgs();

const { t, run } = createReporter();

function guideEl(win, width) {
  const g = win.document.createElement('ytlr-guide-response');
  g.measured = 0;
  g.getBoundingClientRect = () => {
    g.measured++;
    // Out of the page, an element measures 0, as in a browser.
    const w = g.isConnected ? width : 0;
    return { top: 0, left: 0, right: w, bottom: w ? 1080 : 0, width: w, height: w ? 1080 : 0, x: 0, y: 0 };
  };
  return g;
}

function boot(cfg, width, resizeObserver = true) {
  const observers = [];
  let guide;
  const { win, errors } = bootPage({
    userAgent: UA.webos23,
    // No Chromium 38 environment for the legacy bundle: it takes
    // ResizeObserver, and the feature with it.
    environment: modern,
    restoreRemove: false,
    consoleErrors: false,
    fetch: 'pending',
    config: Object.assign({
      enableAdBlock: false, checkForUpdates: false, showWhatsNew: false
    }, cfg),
    beforeEval(win) {
      // The re-check every 2 s runs every 100 ms here.
      const realInterval = win.setInterval.bind(win);
      win.setInterval = (fn, ms, ...args) => realInterval(fn, ms === 2000 ? 100 : ms, ...args);
      // jsdom has none: left out, the page is a webOS 3 or 4 one in this.
      if (resizeObserver) win.ResizeObserver = class {
        constructor(cb) { this.cb = cb; this.live = false; observers.push(this); }
        observe() { this.live = true; }
        disconnect() { this.live = false; }
      };
      guide = guideEl(win, width);
      win.document.querySelector('ytlr-app').appendChild(guide);
    }
  });
  return { win, guide, observers, errors };
}

run(async () => {
  {
    const { win, guide, observers } = boot({ fitPageBesideGuide: false }, 400);
    await wait(500);
    t('off: the guide is never measured', guide.measured === 0, guide.measured + ' measurements');
    t('off: the page is left alone', !win.document.documentElement.hasAttribute('data-ytaf-guide-open'));
    // YouTube makes the guide again.
    guide.parentNode.removeChild(guide);
    win.document.querySelector('ytlr-app').appendChild(guideEl(win, 156));
    await wait(300);
    const live = observers.filter((o) => o.live).length;
    t('a guide made again: only its own observer is left', observers.length === 2 && live === 1, `${observers.length} observers, ${live} live`);
  }
  {
    const { win, errors } = boot({ fitPageBesideGuide: true }, 400);
    await wait(300);
    t('on: an open guide fits the page beside it', win.document.documentElement.hasAttribute('data-ytaf-guide-open'));
    t('no jsdomError', errors.length === 0, errors[0]);
  }
  {
    // On, the open guide removed with no new one: let go, the page let out.
    const { win, guide, observers, errors } = boot({ fitPageBesideGuide: true }, 400);
    await wait(300);
    let resized = 0;
    win.addEventListener('resize', () => resized++);
    guide.parentNode.removeChild(guide);
    await wait(300);
    const n = guide.measured;
    await wait(300);
    t('a removed guide: its observer is disconnected', observers.every((o) => !o.live), observers.map((o) => o.live).join());
    t('a removed guide: the page is let out, one resize', !win.document.documentElement.hasAttribute('data-ytaf-guide-open') && resized === 1, String(resized));
    t('a removed guide: no longer measured', guide.measured === n, `${n} -> ${guide.measured}`);
    // The checks every 2 s after it ran without an error (one that threw would measure nothing either).
    t('a removed guide: no page error on the checks after it', errors.length === 0, errors[0]);
  }
  // ---- The switch in the settings panel ----
  for (const supported of [true, false]) {
    const { win, guide, errors } = boot({ fitPageBesideGuide: true }, 400, supported);
    await wait(300);
    trustedKey(win, GREEN);
    const labels = () => Array.from(win.document.querySelectorAll('.ytaf-ui-container .label-text')).map((s) => s.textContent);
    // The row after it on the same page: the page is built by then.
    const built = await until(() => labels().indexOf('Remove Black Text Boxes') !== -1);
    const shown = labels().indexOf('Fit Page Beside Open Menu') !== -1;
    const name = supported ? 'with ResizeObserver' : 'without ResizeObserver';
    t(name + ': the page with the switch is built', built);
    if (supported) {
      t(name + ': the switch is in the panel', shown);
    } else {
      t(name + ': the switch is left out of the panel', !shown);
      t(name + ': the guide is never measured, the page is left alone', guide.measured === 0 &&
        !win.document.documentElement.hasAttribute('data-ytaf-guide-open'), guide.measured + ' measurements');
    }
    t(name + ': no page error', errors.length === 0, errors[0]);
  }
});
