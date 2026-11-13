/**
 * Checks the user agent the packaged app sends (dist/appinfo.json, copied from
 * assets/appinfo.json by the build).
 *
 * The chipset in it must stay O18: youtube.com/tv turns tile previews
 * (inline_playback) on only for a short list of 2016-2018 chipsets, whatever
 * the platform year, and off for the TV's own on webOS 25 (#144, PR #145).
 * 0.7.7 lost it by taking the LG Content Store app's appinfo.json, which sends
 * $chipSetName$. The rest of the template is checked too: webos-utils.js reads
 * the webOS version from "webOS.TV-<year>" ($platformName$-$platformVersion$)
 * and, failing that, the firmware after "_TV_O18/".
 *
 * Usage: node bench/appinfo-test.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED =
  '$browserName$/$browserVersion$ ($platformName$-$platformVersion$), _TV_O18/$firmwareVersion$ (LG, $modelName$, $networkMode$)';

let passed = 0;
let failed = 0;
const t = (name, ok, detail) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && detail !== undefined) console.log(`  got: ${detail}`);
};

const userAgentOf = (file) => {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return { missing: true };
  return { ua: JSON.parse(fs.readFileSync(full, 'utf8')).vendorExtension?.userAgent };
};

const src = userAgentOf('assets/appinfo.json');
t('assets/appinfo.json: the user agent sends O18', src.ua === EXPECTED, JSON.stringify(src.ua));

const built = userAgentOf('dist/appinfo.json');
t('dist/appinfo.json exists (run after a build)', !built.missing);
t('dist/appinfo.json: the packaged user agent sends O18', built.ua === EXPECTED, JSON.stringify(built.ua));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
