// The YouTube Logo setting on a real TV (#214): the Premium wordmark holds
// when YouTube writes its own onto the header, and after switching to another
// app and back. Set YouTube Logo to Premium, then
//   ares-inspect -d <device> youtube.leanback.v4     (prints the inspector's port)
//   node tv-logo.cjs <inspector port> [device, lgtv] [other app id, com.webos.app.browser]
const { execSync } = require('child_process');
const { sleep, youtubePage, client } = require('./cdp.cjs');
const [port, device = 'lgtv', otherApp = 'com.webos.app.browser'] = process.argv.slice(2);
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0).padStart(4) + 's', ...a);

// A new connection each time: the page's target changes after a resume.
async function state() {
  const t = await youtubePage(port);
  if (!t) return null;
  const c = client(t.webSocketDebuggerUrl);
  const v = await c.evaluate('(function(){var l=document.querySelector(\'ytlr-logo-entity\');var i=l&&l.querySelector(\'ytlr-thumbnail-details\');return {page:(document.body.className.match(/WEB_PAGE_TYPE_\\w+/)||[\'\'])[0],logo:i?(/\\/premium\\//.test(getComputedStyle(i).backgroundImage)?\'PREMIUM\':\'STOCK\'):\'none\',left:l?getComputedStyle(l).left:null,hidden:document.hidden}})()');
  c.close();
  return v && !v.__error ? v : null;
}

(async () => {
  log('waiting for the browse page (pick your profile on the TV if it asks)...');
  let s;
  for (let i = 0; i < 120 && !(s && s.page === 'WEB_PAGE_TYPE_BROWSE'); i++) {
    s = await state();
    await sleep(2000);
  }
  log('browse:', JSON.stringify(s));
  const base = s;

  // Past the old code's poll, then YouTube's own wordmark onto the header, as
  // on a repaint after an idle.
  await sleep(10000);
  const t = await youtubePage(port);
  const c = client(t.webSocketDebuggerUrl);
  await c.evaluate('(function(){var l=document.querySelector(\'ytlr-logo-entity\');var i=l.querySelector(\'ytlr-thumbnail-details\');i.style.backgroundImage=\'url("https://www.gstatic.com/youtube/img/branding/livingroom/youtube/wordmark/fullcolor_white_57_2x_v2.png")\';l.style.left=\'66.375rem\';return 1})()');
  c.close();
  await sleep(1500);
  s = await state();
  log(s && s.logo === 'PREMIUM' && s.left === base.left ? 'PASS' : 'FAIL', 'after YouTube repaints the header:', JSON.stringify(s));

  log('switching to another app...');
  execSync(`ares-launch -d ${device} ${otherApp}`, { stdio: 'ignore' });
  await sleep(15000);
  log('back to YouTube...');
  execSync(`ares-launch -d ${device} youtube.leanback.v4`, { stdio: 'ignore' });
  for (let i = 0; i < 15 && !(s && s.page === 'WEB_PAGE_TYPE_BROWSE' && !s.hidden); i++) {
    await sleep(2000);
    s = await state();
  }
  await sleep(3000);
  s = await state();
  log(s && s.logo === 'PREMIUM' ? 'PASS' : 'FAIL', 'after switching apps and back:', JSON.stringify(s));
})().catch((e) => { console.error(e); process.exit(1); });
