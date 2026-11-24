/**
 * The webOS version matrix: the bundle loaded with the user agent of each
 * webOS generation it serves, checking the branches that depend on the
 * version (src/webos-utils.js and its callers).
 *
 *   node bench/webos-version-test.cjs <bundle> legacy   webOS 3, 4, 5, 6 and the simulator
 *   node bench/webos-version-test.cjs <bundle> modern   webOS 22-26, webOS 25 by its
 *                                                        firmware version, the simulator
 *
 * Almost every other test runs as webOS 3 or webOS 23, so these were not
 * covered: the cast block and its panel option (webOS 25 and newer), the
 * legacy emoji fix and the buffer limit (webOS 4 and older), Fix Black Tile
 * Previews in the panel (webOS 3-6), and a platform year past the table
 * (2026 -> 26, not the simulator fallback).
 *
 * The legacy bundle runs in a Chrome 38 environment, as the other legacy
 * tests do; the modern one in a Chrome 87 one. Each page gets the user agent
 * of its row in the matrix instead of the harness's own two.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, trustedKey, wait } = require('./harness.cjs');

const { flavor } = flavorFromArgs();
const code = readBundle();

const ua = (chrome, year) => 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${chrome} Safari/537.36 WebAppManager` + (year ? ` webOS.TV-${year}` : '');

// The Chrome version each generation ships, and the version the platform year
// maps to (WEBOS_YEAR_MAP in src/webos-utils.js; past 2025, year - 2000).
// Without a year, webos-utils.js falls back to the firmware version
// (_TV_O18/33 and up: webOS 25), then to the Chrome version (simulator mode:
// 120 and up 25, 53 and below 4, else 6). In simulator mode the cast block
// stays off even as webOS 25 (userScript.js), while the panel still offers it.
const MATRIX = {
  legacy: [
    { name: 'webOS 3', ua: ua('38.0.2125.122', 2016), version: 3 },
    { name: 'webOS 4', ua: ua('53.0.2785.34', 2018), version: 4 },
    { name: 'webOS 5', ua: ua('68.0.3440.106', 2020), version: 5 },
    { name: 'webOS 6', ua: ua('79.0.3945.79', 2021), version: 6 },
    { name: 'simulator, Chrome 53', ua: ua('53.0.2785.34'), version: 4, via: 'simulator' },
    { name: 'simulator, Chrome 79', ua: ua('79.0.3945.79'), version: 6, via: 'simulator' },
  ],
  modern: [
    { name: 'webOS 22', ua: ua('87.0.4280.88', 2022), version: 22 },
    { name: 'webOS 23', ua: ua('94.0.4606.31', 2023), version: 23 },
    { name: 'webOS 24', ua: ua('108.0.5359.211', 2024), version: 24 },
    { name: 'webOS 25', ua: ua('120.0.6099.270', 2025), version: 25 },
    { name: 'webOS 26', ua: ua('120.0.6099.270', 2026), version: 26 },
    { name: 'webOS 25 by firmware', ua: ua('120.0.6099.270') + ' _TV_O18/33.10.20', version: 25, via: 'firmware' },
    { name: 'simulator, Chrome 120', ua: ua('120.0.6099.270'), version: 25, via: 'simulator' },
  ],
}[flavor];

const HTML = `<!doctype html><html><head></head><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app>
  <div id="ytlr-player__player-container"><video></video></div>
</ytlr-app></body></html>`;

const { t, run } = createReporter();

function load(entry) {
  const info = [];
  const fetched = [];
  const { win, errors, threw } = bootPage({
    code,
    modern: flavor === 'modern',
    html: HTML,
    userAgent: entry.ua,
    webOS: true,
    errorStacks: true,
    console: { info: (...a) => info.push(a.join(' ')) },
    // The legacy page stays without Element#remove, as before this test
    // moved to the harness.
    restoreRemove: false,
    // After the environment is applied:
    // a fetch that records what reaches it (the cast block cancels before).
    // jsdom has no Request, which src/hooks/fetch.ts checks every request
    // against: without it each one fails with a ReferenceError, which would
    // pass for a block.
    // Only the modern build relies on the TV's own: the legacy one brings its
    // fetch polyfill, which a Request here would turn off.
    beforeEval(win) {
      if (flavor === 'modern') win.Request = Request;
      win.fetch = (resource) => {
        fetched.push(String(resource && resource.url || resource));
        return Promise.resolve({ ok: true, status: 204 });
      };
    },
    catchThrow: true
  });
  return { win, errors, info, threw, fetched };
}

function openPanel(win) {
  trustedKey(win, 404);
  const panel = win.document.querySelector('.ytaf-ui-container');
  if (!panel) return null;
  // Only the first page is built on open, the others one per frame after
  // (ui.js buildDeferredPages): build them all now.
  if (typeof panel.ensurePage !== 'function') throw new Error('the panel has no ensurePage');
  for (let i = 0; i < 20; i++) panel.ensurePage(i);
  return panel.textContent;
}

run(async () => {
  for (const entry of MATRIX) {
    const v = entry.version;
    const { win, errors, info, threw, fetched } = load(entry);
    await wait(600);
    const n = `${flavor} ${entry.name}: `;

    t(n + 'loads without throwing', !threw, threw && String(threw.stack || threw).split('\n').slice(0, 3).join(' | '));
    const via = entry.via || 'platform year';
    // The log names the version the detection returned, after it is set.
    const detected = new RegExp(`Detected webOS ${v} via ${via === 'simulator' ? 'Chrome version: \\d+ \\(simulator mode\\)'
      : via === 'firmware' ? 'firmware version' : 'platform year'}`);
    t(n + `detected as webOS ${v} by ${via}`, info.some((l) => detected.test(l)),
      info.filter((l) => /WebOSUtils/.test(l)).join(' | ') || '(no detection logged)');

    // On from webOS 25, except in simulator mode.
    const blocks = v >= 25 && via !== 'simulator';
    const castBlock = info.some((l) => /Enabling webOS Google Cast Block/.test(l));
    t(n + (blocks ? 'the cast block is on' : 'no cast block'), castBlock === blocks);

    // What the cast block does (src/block-webos-cast.ts): YouTube's wake of
    // the webOS cast service is cancelled, unless the app was launched to cast.
    const reaches = async (url) => {
      const before = fetched.length;
      let rejected = false;
      try { await win.fetch(url); } catch { rejected = true; }
      return !rejected && fetched.length > before;
    };
    t(n + `wake_cast_core ${blocks ? 'blocked' : 'let through'}`,
      (await reaches('/wake_cast_core')) === !blocks);
    t(n + 'any other request let through', await reaches('/youtubei/v1/browse'));
    if (blocks) {
      // The relaunch also opens the video, a navigation jsdom reports as
      // "Not implemented"; that report is not an error of the bundle.
      const before = errors.length;
      win.document.dispatchEvent(new win.CustomEvent('webOSRelaunch',
        { detail: { contentTarget: 'https://www.youtube.com/tv?dialLaunch=watch&v=x' } }));
      const rest = errors.splice(before).filter((e) => !/Not implemented: navigation/.test(e));
      errors.push(...rest);
      t(n + 'after a cast launch, wake_cast_core let through', await reaches('/wake_cast_core'));
    }

    // Legacy-only modules: the modern build leaves them out altogether.
    const oldTv = flavor === 'legacy' && v <= 4;
    const emojiClass = win.document.documentElement.classList.contains('ytaf-legacy-emoji');
    t(n + (oldTv ? 'the legacy emoji fix is on' : 'no legacy emoji fix'), emojiClass === oldTv);
    const bufferLimit = info.some((l) => /Initiating buffer limit/.test(l));
    t(n + (oldTv ? 'the buffer limit is on' : 'no buffer limit'), bufferLimit === oldTv);

    let text = null, panelThrew = null;
    try { text = openPanel(win); } catch (e) { panelThrew = e; }
    t(n + 'the settings panel opens', !panelThrew && text !== null, panelThrew && panelThrew.message);
    if (text !== null) {
      const has = (label) => text.indexOf(label) !== -1;
      t(n + `panel: Block webOS Cast Service ${v >= 25 ? 'offered' : 'not offered'}`,
        has('Block webOS Cast Service') === (v >= 25));
      t(n + 'panel: Fix Black Tile Previews offered', has('Fix Black Tile Previews'));
    }
    t(n + 'no console.error / jsdomError', errors.length === 0, errors.slice(0, 2).join(' || '));
    win.close();
  }
});
