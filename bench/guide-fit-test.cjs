/**
 * Fit Page Beside Menu (src/guide-fit.js): off, the guide is not measured at
 * all (the check every 2 s forced a layout each time); a guide YouTube makes
 * again takes the old one's observer with it; on, an open guide fits the page.
 *
 * Usage: node bench/guide-fit-test.cjs [bundle] [legacy|modern]
 */
const { flavorFromArgs, bootPage, wait, UA } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment.
// The legacy one runs with no environment applied (see boot); the user agent
// is webOS 23 on both.
const { modern } = flavorFromArgs();

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

function guideEl(win, width) {
  const g = win.document.createElement('ytlr-guide-response');
  g.measured = 0;
  g.getBoundingClientRect = () => {
    g.measured++;
    return { top: 0, left: 0, right: width, bottom: 1080, width, height: 1080, x: 0, y: 0 };
  };
  return g;
}

function boot(cfg, width) {
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
      win.ResizeObserver = class {
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

(async () => {
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
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
