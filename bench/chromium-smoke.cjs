/**
 * The bundle in a real Chromium (Playwright), for what jsdom cannot show:
 * layout and CSS, real focus and trusted key events, the engine's own fetch
 * and Request. Every other bench test runs in jsdom.
 *
 *   node bench/chromium-smoke.cjs <bundle> [legacy|modern]
 *
 * The page is youtube.com/tv as far as the bundle can tell: the request for it
 * is answered here with a bare YouTube TV-shaped page, and every other request
 * is answered empty and recorded, so nothing leaves the machine. It runs as
 * webOS 25 (modern) or webOS 3 (legacy) by its user agent; the engine is
 * Playwright's Chromium either way, so this checks behaviour in a browser, not
 * the old engines (chrome38-env.cjs does that in jsdom).
 *
 * Needs the playwright package and its Chromium. Without them it is skipped,
 * except under CI, where that is a failure. The workflow installs both.
 */
// The functions given to page.evaluate() and addInitScript() run in the page.
/* global window, document, getComputedStyle */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
const modern = process.argv[3] === 'modern';

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  if (process.env.CI) {
    console.log('FAIL no playwright package for bench/chromium-smoke.cjs');
    process.exit(1);
  }
  console.log('skipped: no playwright package');
  process.exit(0);
}

const UA = modern
  ? 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.270 Safari/537.36 WebAppManager webOS.TV-2025'
  : 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/38.0.2125.122 Safari/537.36 WebAppManager webOS.TV-2016';

const PAGE = `<!doctype html><html><head><title>YouTube on TV</title></head>
<body class="WEB_PAGE_TYPE_BROWSE" style="margin:0;background:#000">
<ytlr-app>
  <div id="ytlr-player__player-container"><video></video></div>
</ytlr-app></body></html>`;

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

(async () => {
  let browser;
  try {
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  } catch (e) {
    if (process.env.CI) throw e;
    console.log('skipped: no Chromium for playwright (' + String(e.message).split('\n')[0] + ')');
    process.exit(0);
  }
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1920, height: 1080 } });
  const requested = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url === 'https://www.youtube.com/tv' || url === 'https://www.youtube.com/tv/') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    }
    requested.push(url);
    return route.fulfill({ status: 204, body: '' });
  });
  // What the webOS app shell gives the page.
  await context.addInitScript(() => {
    window.launchParams = '{}';
    window.webOS = { deviceInfo: (cb) => cb({ modelName: 'sim' }), platformBack: () => {} };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  await page.goto('https://www.youtube.com/tv');
  await page.addScriptTag({ content: fs.readFileSync(bundlePath, 'utf8') });
  await page.waitForTimeout(1000);
  const f = modern ? 'modern (webOS 25)' : 'legacy (webOS 3)';
  const n = (s) => `${f}: ${s}`;

  t(n('loads without a page error'), errors.length === 0, errors.slice(0, 3).join(' || '));
  const hooked = await page.evaluate(() => ({
    parse: JSON.parse.toString().indexOf('native code') === -1,
    stringify: JSON.stringify.toString().indexOf('native code') === -1
  }));
  t(n('JSON.parse and JSON.stringify hooked'), hooked.parse && hooked.stringify, JSON.stringify(hooked));

  // The bundle's stylesheet, applied by the engine.
  const css = await page.evaluate(() => {
    const sheet = [...document.querySelectorAll('style')].find((s) => s.textContent.indexOf('.ytaf-ui-container') !== -1);
    return { found: !!sheet, rules: sheet && sheet.sheet ? sheet.sheet.cssRules.length : 0 };
  });
  t(n('the stylesheet is parsed by the engine'), css.found && css.rules > 50, JSON.stringify(css));

  // The settings panel: opened with the green key, a trusted key press with
  // the remote's code (404), sent as the browser's own input.
  const cdp = await context.newCDPSession(page);
  const remoteKey = async (code, key) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    }
  };
  await remoteKey(404, 'ColorF1Green');
  await page.waitForTimeout(300);
  const panel = await page.evaluate(() => {
    const el = document.querySelector('.ytaf-ui-container');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const active = document.activeElement;
    return { w: r.width, h: r.height, left: r.left, top: r.top, position: cs.position,
      display: cs.display, visibility: cs.visibility, focusInside: !!active && el.contains(active),
      focusTag: active && active.tagName };
  });
  t(n('the green key opens the panel'), !!panel);
  if (panel) {
    t(n('the panel is laid out on screen'), panel.w > 300 && panel.h > 300 && panel.left >= 0 && panel.top >= 0 &&
      panel.left + panel.w <= 1920 && panel.top + panel.h <= 1080 && panel.display !== 'none' && panel.visibility !== 'hidden',
      JSON.stringify(panel));
    t(n('the panel has the focus'), panel.focusInside, panel.focusTag);
    // A real arrow key press moves the focus within the panel.
    const before = await page.evaluate(() => document.activeElement && document.activeElement.outerHTML.slice(0, 120));
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => {
      const el = document.querySelector('.ytaf-ui-container');
      const a = document.activeElement;
      return { inside: !!a && el.contains(a), html: a && a.outerHTML.slice(0, 120) };
    });
    t(n('the down arrow moves the focus within the panel'), after.inside && after.html !== before, `${before} -> ${after.html}`);
  }

  // The engine's own fetch through the bundle's hook.
  const castWake = await page.evaluate(async () => {
    try { await fetch('/wake_cast_core'); return 'reached'; } catch (e) { return 'rejected: ' + e.message; }
  });
  const other = await page.evaluate(async () => {
    try { const r = await fetch(new Request('/youtubei/v1/browse?probe=1')); return 'reached ' + r.status; } catch (e) { return 'rejected: ' + e.message; }
  });
  if (modern) {
    t(n('the cast block cancels wake_cast_core before it leaves the page'),
      /^rejected/.test(castWake) && !requested.some((u) => /wake_cast_core/.test(u)), castWake);
  } else {
    t(n('no cast block: wake_cast_core goes out'), castWake === 'reached' && requested.some((u) => /wake_cast_core/.test(u)), castWake);
  }
  t(n('a Request object goes through the hook to the network'), other === 'reached 204' &&
    requested.some((u) => /probe=1/.test(u)), other);

  t(n('no page error after all of it'), errors.length === 0, errors.slice(0, 3).join(' || '));
  const outside = requested.filter((u) => !/^https:\/\/www\.youtube\.com\//.test(u));
  console.log(`[info] requests answered here: ${requested.length} (${outside.length} to other hosts)`);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
