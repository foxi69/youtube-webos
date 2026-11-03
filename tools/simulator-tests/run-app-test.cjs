// Tests the built app in a webOS TV Simulator, over DevTools (see README.md):
//   node run-app-test.cjs <simulator .exe> [app dir, default dist]
// Env: PORT (9229), OUT (simulator-results), LABEL (webos<version>-<app dir>),
//   LOGO=premium|youtube   the YouTube Logo setting, and its repaint check
//   FEATURES=1             the optional watch-page features on
//   EFFECTS=1              does each setting do what it should (sample and real data)
//   SWEEP=1                every control in the panel, through all its values
//   TV_LIKE=0              without the TV's user agent, page size and slower CPU
//   TV_CPU=<n>             another CPU slow-down than the year's
//   BLOCK_VIDEO=1          no video data (UI checks only)
//   STOP_AFTER_WATCH=1     leave the simulator open on the playing video
// Exit: 0 all passed, 1 a check failed, 2 an error, 3 the simulator's page
// crashed (run-all.cjs starts again), 4 over 10 minutes.
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { sleep, targets, youtubePage, client, js, settingLabels } = require('./cdp.cjs');

const [exe, appArg = 'dist'] = process.argv.slice(2);
if (!exe) {
  console.error('usage: node run-app-test.cjs <simulator .exe> [app dir]');
  process.exit(2);
}
const appDir = path.resolve(appArg);
const bundlePath = path.join(appDir, 'webOSUserScripts', 'userScript.js');
const repo = path.join(__dirname, '..', '..');
const port = process.env.PORT || 9229;
const outDir = path.resolve(process.env.OUT || path.join(repo, 'simulator-results'));
const simMatch = /webOS_TV_(\d+)(?:\.\d+)?_Simulator/.exec(path.basename(exe));
const label = process.env.LABEL || `webos${simMatch ? simMatch[1] : 'x'}-${path.basename(appDir)}`;
fs.mkdirSync(outDir, { recursive: true });
const bundle = fs.readFileSync(bundlePath, 'utf8');
const descs = settingLabels();
const results = [];
const exceptions = [];
const consoleErrors = [];
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's', ...a);
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(ok ? 'PASS' : 'FAIL', name, detail ? `(${String(detail).slice(0, 200)})` : '');
};

(async () => {
  // The app folder is the simulator's first argument. No throttling when the
  // window is covered or in the background: the tests run while you do other
  // things. A simulator still on the port would give its page to this run.
  if ((await targets(port).catch(() => [])).length) {
    console.error(`port ${port} is in use: close the simulator on it, or set PORT`);
    process.exit(2);
  }
  const sim = spawn(exe, [appDir, '{}', `--remote-debugging-port=${port}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'], { stdio: 'ignore' });
  const t = await youtubePage(port, 60000);
  if (!t) throw new Error('the app did not start in the simulator');
  // A run that hangs (a frozen page) ends after 10 minutes, with what it has.
  setTimeout(() => {
    log('TIMEOUT: the run took over 10 minutes');
    try { fs.writeFileSync(path.join(outDir, `${label}-results.json`), JSON.stringify({ results, exceptions, consoleErrors, timeout: true }, null, 2)); } catch { /* best effort */ }
    try { execSync(`taskkill /PID ${sim.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
    process.exit(4);
  }, 600000);
  log('app page', t.url);
  let closed = false;
  const c = client(t.webSocketDebuggerUrl);
  const { evaluate, key } = c;
  const shot = async (name) => {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    if (r.result) fs.writeFileSync(path.join(outDir, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const waitFor = async (expr, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (closed) {
        // The simulator's renderer crashes now and then once YouTube loads,
        // with or without our code: the caller starts again.
        log('page crashed: retry');
        try { execSync(`taskkill /PID ${sim.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
        process.exit(3);
      }
      const v = await evaluate(expr);
      if (v && !v.__error) return v;
      await sleep(500);
    }
    return null;
  };

  c.on((msg) => {
    const p = msg.params || {};
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      exceptions.push(((d.exception && d.exception.description) || d.text || '').split('\n').slice(0, 3).join(' | '));
    } else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      consoleErrors.push(p.args.map((a) => (a.value !== undefined ? a.value : a.description)).join(' ').slice(0, 200));
    }
  });
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Network.enable');
  const blockVideo = process.env.BLOCK_VIDEO === '1';
  if (blockVideo) {
    await c.send('Network.setBlockedURLs', { urls: ['*googlevideo.com*'] });
    log('video data blocked');
  }

  // 1. The settings to start from, set before our code reads them. Every run
  // from the defaults: earlier runs leave settings in the simulator's profile.
  // No update or What's new window: a test build can be older than the release.
  const preset = { checkForUpdates: false, showWhatsNew: false };
  if (process.env.LOGO) preset.logoStyle = process.env.LOGO;
  if (process.env.FEATURES === '1') Object.assign(preset, {
    enableReturnYouTubeDislike: true, enableDeArrow: true, showMostReplayed: true,
    timeRemainingMode: 'both', showQualityInTitle: true, showQualityOnStart: true,
    showWatchTime: true, clockMode: 'time', hideEndcards: true, enableTrackingBlock: true, markAiVideos: true
  });
  const presetCode = `try{Object.keys(localStorage).forEach(function(k){if(/^ytaf-configuration/.test(k))localStorage.removeItem(k)});localStorage.setItem('ytaf-configuration',JSON.stringify(${js(preset)}))}catch(e){}`;
  // Every request, to see which services the features reach.
  const requests = [];
  c.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
  });
  // A read-only counter around our JSON.parse hook: for each real YouTube
  // response, what the raw text held (ads, Shorts, live) and what is left
  // after our code. It keeps up to 60 raw responses for effects-page.js's
  // replay() (the settings tried on YouTube's real data).
  const counter = '(function(){var ours=JSON.parse;var M={ads:/"(adPlacements|adSlots|playerAds)":\\[\\{|"adSlotRenderer"|"promotedSparklesWebRenderer"|"adsEngagementPanel/g,shorts:/"reelShelfRenderer"|"shortsLockupViewModel"|"reelItemRenderer"|TILE_STYLE_YTLR_SHORTS/g,live:/BADGE_STYLE_LIVE|"style":"LIVE"/g};var S=window.__ytafReal={responses:0,raw:{ads:0,shorts:0,live:0},out:{ads:0,shorts:0,live:0}};function n(re,t){var m=t.match(re);return m?m.length:0}S.texts=[];var wrap=function(t,r){var o=ours.apply(this,arguments);try{if(!window.__ytafReplaying&&typeof t===\'string\'&&t.length>2000&&t.charAt(0)===\'{\'){if(S.texts.length<60&&t.length<3000000)S.texts.push(t);var after=window.__ytafNativeStringify?window.__ytafNativeStringify(o):\'\';S.responses++;for(var k in M){S.raw[k]+=n(M[k],t);if(after)S.out[k]+=n(M[k],after)}}}catch(e){}return o};JSON.parse=wrap;})();';
  // The simulators send no platform year in the user agent, only the Chromium
  // of the version they simulate, and the app then takes webOS 22-24 for
  // webOS 6 (webos-utils.js's fallback). A TV's agent has "webOS.TV-<year>".
  const simYear = simMatch ? ({ 6: 2021, 22: 2022, 23: 2023, 24: 2024, 25: 2025, 26: 2026 })[+simMatch[1]] : null;
  // As close to a TV as the simulator gets (TV_LIKE, on by default):
  //  - the TV's own user agent, in the form appinfo.json's vendorExtension
  //    gives it (read from a webOS 25 TV); for the older years the chip,
  //    firmware and model are examples in that form;
  //  - 1920x1080, the TV's page size;
  //  - the CPU slowed down to roughly a TV's (an estimate).
  const TV = {
    2021: { ua: 'LG Browser/7.00.00 (webOS.TV-2021), _TV_O20/03.33.85 (LG, OLED55C1, wireless)', cpu: 6 },
    2022: { ua: 'LG Browser/7.00.00 (webOS.TV-2022), _TV_O22/03.30.75 (LG, OLED55C2, wireless)', cpu: 5 },
    2023: { ua: 'LG Browser/8.00.00 (webOS.TV-2023), _TV_O22N/13.11.60 (LG, OLED55C3, wireless)', cpu: 4 },
    2024: { ua: 'LG Browser/8.00.00 (webOS.TV-2024), _TV_O24/23.20.70 (LG, OLED55C4, wireless)', cpu: 4 },
    2025: { ua: 'LG Browser/8.00.00 (webOS.TV-2025), _TV_K24N/33.31.75 (LG, 55QNED92A6A.CEUDKH, wireless)', cpu: 4 }
  };
  const tvLike = process.env.TV_LIKE !== '0' && simYear && TV[simYear];
  const fixUa = tvLike
    ? `try{Object.defineProperty(navigator,'userAgent',{get:function(){return ${js(tvLike.ua)}},configurable:true})}catch(e){}`
    : simYear
      ? `try{var UA=navigator.userAgent;if(!/webOS\\.TV-\\d{4}/.test(UA))Object.defineProperty(navigator,'userAgent',{get:function(){return UA+' webOS.TV-${simYear}'},configurable:true})}catch(e){}`
      : '';
  if (tvLike) {
    // The requests too: YouTube's servers see the TV's agent.
    await c.send('Network.setUserAgentOverride', { userAgent: tvLike.ua, platform: 'Linux' });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    if (process.env.TV_CPU) tvLike.cpu = +process.env.TV_CPU;
    await c.send('Emulation.setCPUThrottlingRate', { rate: tvLike.cpu });
    log(`TV-like: ${tvLike.ua.slice(0, 48)}..., 1920x1080, CPU ${tvLike.cpu}x slower`);
  }
  // The simulator does not inject webOSUserScripts as the TV's WAM does: put
  // the bundle into every YouTube document, at DOMContentLoaded at the
  // earliest (where WAM puts it: earlier, YouTube rewrites <html> and our
  // classes and stylesheet are lost). Once per document. Page.reload would
  // close the app in the simulator, so the current document gets it directly.
  const wrapped = `(function(){if(window.__ytafInjected||!/youtube\\.com$/.test(location.host))return;window.__ytafInjected=1;window.__ytafNativeStringify=JSON.stringify.bind(JSON);${fixUa}${presetCode}function go(){\n${bundle}\n;${counter}}` +
    'if(document.readyState!==\'loading\'){go();return;}document.addEventListener(\'DOMContentLoaded\',go);})();';
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: wrapped });
  await c.send('Runtime.runIfWaitingForDebugger');
  log('injected, readyState', await evaluate(wrapped + ';document.readyState'));
  c.on((msg) => {
    if (msg.method === 'Inspector.detached' || msg.method === 'Inspector.targetCrashed') {
      closed = true;
      log('APP CLOSED/CRASHED:', msg.method, JSON.stringify(msg.params));
    }
    if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) log('navigated', msg.params.frame.url);
  });
  const onYouTube = await waitFor('/youtube\\.com/.test(location.host)', 60000);
  check('start page goes to YouTube', !!onYouTube, await evaluate('location.href'));
  log('user agent as the app sees it:', String(await evaluate('navigator.userAgent')).slice(-40), simYear ? `(platform year ${simYear} added)` : '');
  const ours = await waitFor('document.querySelectorAll(\'[id*=ytaf],[class*=ytaf]\').length || Object.keys(localStorage).filter(function(k){return /ytaf/i.test(k)}).length', 30000);
  check('userScript runs (its elements or storage are there)', !!ours, ours);
  const app = await waitFor('document.body && /WEB_PAGE_TYPE_/.test(document.body.className) && document.body.className', 30000);
  check('YouTube TV app renders', !!app, app);
  await sleep(3000);
  await shot('1-start');

  // 2. Past the welcome and account screens: click "Start"/"Kezdés", then
  // the guest entry, with the mouse (the TV app takes pointer input).
  const clickText = async (re) => {
    const rect = await evaluate(`(function(){var re=${re};var els=Array.prototype.filter.call(document.querySelectorAll('body *'),function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&re.test((e.innerText||'').trim())&&e.children.length<4});els.sort(function(a,b){return a.innerText.length-b.innerText.length});var e=els[0];if(!e)return null;var r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,t:e.innerText.trim().slice(0,30)}})()`);
    if (!rect || rect.__error) return null;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await sleep(80);
    }
    return rect.t;
  };
  for (let i = 0; i < 12; i++) {
    const page = String(await evaluate('document.body.className'));
    const type = (page.match(/WEB_PAGE_TYPE_\w+/) || [''])[0];
    if (!/WELCOME|ACCOUNT|SIGN_IN|GUEST/.test(type)) break;
    // OK on the focused "Start" button, as an in-page key event: YouTube's
    // handler takes those (pointer clicks and CDP keys did not get through).
    await evaluate('(function(){function k(code,name){[\'keydown\',\'keyup\'].forEach(function(t){var e=new KeyboardEvent(t,{bubbles:true,cancelable:true,key:name,code:name});Object.defineProperty(e,\'keyCode\',{get:function(){return code}});Object.defineProperty(e,\'which\',{get:function(){return code}});document.body.dispatchEvent(e)})}k(13,\'Enter\');return true})()');
    log('page', type, '-> OK (in page)');
    await sleep(5000);
    await shot(`2-step${i}`);
  }
  const browse = await waitFor('/WEB_PAGE_TYPE_BROWSE/.test(document.body.className) && document.body.className.match(/WEB_PAGE_TYPE_\\w+/)[0]', 20000);
  check('browse page loads', !!browse, browse || await evaluate('document.body.className'));
  await sleep(3000);
  await shot('2-browse');

  // 2b. YouTube Logo (PR #98): the chosen wordmark shows, and holds when
  // YouTube writes its own onto the header again (what it does after a
  // resume or a long idle).
  if (process.env.LOGO) {
    const want = process.env.LOGO;
    const logoState = '(function(){var l=document.querySelector(\'ytlr-logo-entity\');var i=l&&l.querySelector(\'ytlr-thumbnail-details\');if(!i)return null;return {bg:getComputedStyle(i).backgroundImage,left:getComputedStyle(l).left,width:getComputedStyle(l).width,cls:document.documentElement.className}})()';
    const s1 = await waitFor(logoState, 15000);
    const isWant = (s) => !!s && (want === 'premium' ? /\/premium\//.test(s.bg) : /\/youtube\/wordmark\//.test(s.bg));
    check(`logo: ${want} wordmark shows`, isWant(s1), s1 && `${s1.bg.slice(-70)} left ${s1.left} width ${s1.width}`);
    log('logo diag:', JSON.stringify(await evaluate('(function(){var st=document.getElementById(\'ytaf-logo-style\');return {htmlYtaf:(document.documentElement.className.match(/ytaf-[\\w-]+/g)||[]).join(\' \'),sheet:!!st,sheetInHead:!!(st&&st.parentNode===document.head),sheetText:st?st.textContent.slice(0,120):null,stored:Object.keys(localStorage).filter(function(k){return /ytaf-configuration/.test(k)}).map(function(k){var c=JSON.parse(localStorage.getItem(k)||\'{}\');return k+\' logoStyle=\'+c.logoStyle+\' perAccount=\'+c.perAccountSettings})}})()')));
    await shot('2b-logo');
    const other = want === 'premium'
      ? 'https://www.gstatic.com/youtube/img/branding/livingroom/youtube/wordmark/fullcolor_white_57_2x_v2.png'
      : 'https://www.gstatic.com/youtube/img/branding/livingroom/premium/wordmark_truncated/fullcolor_white_57_2x_v2.png';
    // Wait past the old code's 15 s poll, then repaint like YouTube does.
    await sleep(Math.max(0, 26000 - (Date.now() - t0)));
    await evaluate(`(function(){var l=document.querySelector('ytlr-logo-entity');var i=l.querySelector('ytlr-thumbnail-details');i.style.backgroundImage='url("${other}")';l.style.left='66rem';l.style.width='10rem';return true})()`);
    await sleep(2000);
    const s2 = await evaluate(logoState);
    check(`logo: ${want} wordmark holds after YouTube repaints the header`, isWant(s2) && s2.left === s1.left && s2.width === s1.width,
      s2 && `${s2.bg.slice(-70)} left ${s2.left} width ${s2.width}`);
  }

  // 3. Settings panel with the green key (404), every tab.
  await key(404, 'Green');
  const panelOpen = '(function(){var p=document.querySelector(\'.ytaf-ui-container\');if(!p)return false;var r=p.getBoundingClientRect(),cs=getComputedStyle(p);return r.width>0&&r.height>0&&cs.display!==\'none\'&&cs.visibility!==\'hidden\'})()';
  // One press: a second one would close a panel that was only slow to open.
  await waitFor(panelOpen, 15000);
  const panel = await waitFor('(function(){var p=document.querySelector(\'.ytaf-ui-container\');if(!p)return false;var r=p.getBoundingClientRect(),cs=getComputedStyle(p);return r.width>0&&r.height>0&&cs.display!==\'none\'&&cs.visibility!==\'hidden\'})()', 8000);
  check('green key opens the settings panel', !!panel);
  if (!panel) {
    await shot('3-panel-fail');
    log('dialogs on screen:', JSON.stringify(await evaluate('Array.prototype.map.call(document.querySelectorAll(\'[class*=ytaf-dialog],[class*=ytaf-modal],[id*=ytaf-dialog],[role=dialog]\'),function(e){return (e.id||e.className)+\': \'+(e.innerText||\'\').trim().slice(0,60)})')));
  }
  if (panel) {
    const tabs = await evaluate('Array.prototype.map.call(document.querySelectorAll(\'.ytaf-ui-container .ytaf-tab-btn\'), function(t){return (t.textContent||\'\').trim()}).filter(Boolean)');
    check('settings tabs present', Array.isArray(tabs) && tabs.length >= 5, JSON.stringify(tabs));
    await shot('3-panel');
    const n = Array.isArray(tabs) ? tabs.length : 0;
    const before = exceptions.length;
    for (let i = 0; i < n; i++) {
      await evaluate(`(function(){var t=document.querySelectorAll('.ytaf-ui-container .ytaf-tab-btn')[${i}]; t && t.click(); return true})()`);
      await sleep(600);
      const rows = await evaluate('document.querySelectorAll(\'.ytaf-ui-container input, .ytaf-ui-container button, .ytaf-ui-container [tabindex]\').length');
      log('tab', i, tabs[i], 'controls', rows);
    }
    check('every tab opens without an error', exceptions.length === before, exceptions.slice(before).join(' || '));
    await key(461, 'Back');
    // A slowed-down CPU (TV-like) closes it later: wait for it, up to 4 s.
    await waitFor(`!(${panelOpen})`, 4000);
    const closed = await evaluate('(function(){var p=document.querySelector(\'.ytaf-ui-container\');if(!p)return true;var r=p.getBoundingClientRect(),cs=getComputedStyle(p);return !(r.width>0&&r.height>0&&cs.display!==\'none\'&&cs.visibility!==\'hidden\')})()');
    check('Back closes the panel', !!closed);
  }

  // 4. A video plays (deep link like the TV's launch with a content id).
  if (blockVideo) {
    // Stay a while on the browse page instead, to see it holds.
    await waitFor('false', 15000);
  } else {
  await evaluate('location.hash = \'#/watch?v=aqz-KE-bpKQ\'; true');
  // "Who's watching" comes before a video for a signed-out viewer: as a guest.
  for (let i = 0; i < 3; i++) {
    await sleep(4000);
    const type = String(await evaluate('(document.body.className.match(/WEB_PAGE_TYPE_\\w+/)||[""])[0]'));
    if (!/ACCOUNT|WELCOME|GUEST|SIGN_IN|LOGIN|ADD_ACCOUNT/.test(type)) break;
    // The pointer click does not reach YouTube's handler: focus the guest
    // button with the remote's arrows and press OK, like on the TV.
    // What auto-login.js does for a guest: Down, then OK, as in-page key
    // events (utils.js sendKey), which YouTube's own handler takes.
    // YouTube marks the focused item with .zylon-focus. A signed-in account
    // tile is taken as it is (focused first); otherwise Down until the guest
    // button ("...as guest"), then OK.
    const picked = await evaluate('(function(){function k(code,name){[\'keydown\',\'keyup\'].forEach(function(t){var e=new KeyboardEvent(t,{bubbles:true,cancelable:true,key:name,code:name});Object.defineProperty(e,\'keyCode\',{get:function(){return code}});Object.defineProperty(e,\'which\',{get:function(){return code}});document.body.dispatchEvent(e)})}function focused(){var f=document.querySelectorAll(\'.zylon-focus\');var d=f[f.length-1];return d?(d.innerText||\'\').trim():\'\'}var notAccount=/hozzáadás|add account|gyermek|kids|vendég|guest|bejelentkez|sign in/i;var first=focused();var want=first&&!notAccount.test(first)?first.split(\'\\n\')[0]:null;var hasWant=!!want;var seen=[];return new Promise(function(res){var n=0;function go(){var t=focused();var name=t.split(\'\\n\')[0];seen.push(name.slice(0,20));var isWant=hasWant&&name===want;var guest=/vendégként|as guest/i.test(t);if(isWant||(!hasWant&&guest)){k(13,\'Enter\');res(seen.join(\' > \')+\' => OK\');return}if(n++>12){res(seen.join(\' > \')+\' => nothing to pick\');return}k(hasWant?39:40,hasWant?\'ArrowRight\':\'ArrowDown\');setTimeout(go,600)}go()})})()');
    await sleep(3000);
    const after = String(await evaluate('(document.body.className.match(/WEB_PAGE_TYPE_\\w+/)||[""])[0]'));
    log('page', type, '->', picked, '->', after);
    const hit = !/ACCOUNT_SELECTOR/.test(after);
    if (!hit) {
      // The add-account screen: back to "Who's watching", where the guest is.
      await key(461, 'Back');
      await sleep(2500);
      log('page', type, '-> Back, then guest:', await clickText('/vendégként$|as guest$|^(Vendég|Guest)$/i'));
    }
    await shot(`4-guest${i}`);
  }
  const playing = await waitFor('(function(){var v=document.querySelector(\'video\');return v&&v.currentTime>3&&!v.paused&&v.currentTime})()', 45000);
  check('a video plays', !!playing, playing ? `at ${Number(playing).toFixed(1)} s` : await evaluate('(function(){var v=document.querySelector(\'video\');return v?(\'t=\'+v.currentTime+\' paused=\'+v.paused+\' rs=\'+v.readyState+\' err=\'+(v.error&&v.error.code)):\'no video\'})()'));
  await shot('4-watch');
  const rate = await evaluate('(function(){var v=document.querySelector(\'video\');return v&&v.playbackRate})()');
  log('playbackRate', rate);
  // STOP_AFTER_WATCH=1: leave the simulator open on the playing video, to look.
  if (process.env.STOP_AFTER_WATCH === '1') {
    log('stopping here: the simulator stays open on the video (port ' + port + ')');
    c.close();
    fs.writeFileSync(path.join(outDir, `${label}-results.json`), JSON.stringify({ results, exceptions, consoleErrors }, null, 2));
    process.exit(results.some((r) => !r.ok) ? 1 : 0);
  }

  // 5. The features on the watch page.
  if (playing) {
    await sleep(10000);
    const seen = (re) => requests.some((u) => re.test(u));
    check('SponsorBlock asks for the video\'s segments', seen(/sponsor\.ajay\.app\/api\/skipSegments/), requests.filter((u) => /ajay\.app/.test(u)).slice(0, 3).join(' '));
    if (process.env.FEATURES === '1') {
      check('Return YouTube Dislike asks for the votes', seen(/returnyoutubedislikeapi\.com/));
      check('DeArrow asks for branding', seen(/ajay\.app\/api\/branding/), requests.filter((u) => /branding/.test(u)).slice(0, 2).join(' '));
      const overlays = await evaluate('(function(){var out={};var ids=Array.prototype.map.call(document.querySelectorAll(\'[id^=ytaf],[class*=ytaf-]\'),function(e){return e.id||String(e.className).split(\' \').filter(function(c){return /^ytaf-/.test(c)})[0]});ids.forEach(function(i){if(i)out[i]=1});return Object.keys(out).sort().join(\' \')})()');
      log('our elements on the watch page:', overlays);
      check('watch page overlays are there', typeof overlays === 'string' && overlays.length > 0, overlays);
    }
    await shot('5-features');

    // Playback speed: what YouTube's Speed menu does, 1.5x, then the time
    // the video covers in 10 s of wall time.
    const t1 = await evaluate('(function(){var v=document.querySelector(\'video\');v.playbackRate=1.5;return v.currentTime})()');
    await sleep(3000);
    const a = await evaluate('document.querySelector(\'video\').currentTime');
    const w0 = Date.now();
    await sleep(10000);
    const b = await evaluate('(function(){var v=document.querySelector(\'video\');return {t:v.currentTime,rate:v.playbackRate,paused:v.paused}})()');
    const ratio = (b.t - a) / ((Date.now() - w0) / 1000);
    log('speed: from', t1, 'video advanced', (b.t - a).toFixed(1), 's in 10 s, x', ratio.toFixed(2), JSON.stringify(b));
    check('1.5x plays at about 1.5x', ratio > 1.3 && ratio < 1.7 && !b.paused, `x${ratio.toFixed(2)}`);
    await evaluate('(function(){document.querySelector(\'video\').playbackRate=1;return true})()');
    await sleep(3000);
  }

  // 5b. Do the settings do what they should? EFFECTS=1.
  //  - JSON-level cases (effects-page.js): each setting off, then on, through
  //    the panel; a sample response through YouTube's JSON.parse/stringify;
  //    the effect must be there when on and absent when off.
  //  - Every other setting: one press through the panel, and what our code
  //    shows before and after (classes, our elements, our styles, the video).
  if (process.env.EFFECTS === '1') {
    if (!(await evaluate(panelOpen))) await key(404, 'Green');
    const fxPanel = await waitFor(panelOpen, 15000);
    check('the panel opens for the effect tests', !!fxPanel);
    if (fxPanel) {
      const fxSrc = fs.readFileSync(path.join(__dirname, 'effects-page.js'), 'utf8');
      await evaluate(`window.__ytafDescs=${js(descs)};${fxSrc};true`);
      const nCases = await evaluate('window.__ytafFx.cases.length');
      const fxResults = [];
      for (let i = 0; i < nCases; i++) {
        const meta = await evaluate(`(function(){var c=__ytafFx.cases[${i}];return {name:c.name,key:c.key,on:c.on,off:c.off,needs:c.needs}})()`);
        const keys = [meta.key].concat(Object.keys(meta.needs));
        const orig = await evaluate(`(function(){var o={};${js(keys)}.forEach(function(k){o[k]=__ytafFx.get(k)});return o})()`);
        const setv = async (k, v) => { const r = await evaluate(`__ytafFx.set(${js(k)}, ${js(v)}).then(function(x){return JSON.stringify(x)})`); return typeof r === 'string' ? JSON.parse(r) : r; };
        for (const k of Object.keys(meta.needs)) await setv(k, meta.needs[k]);
        const sOff = await setv(meta.key, meta.off);
        const rOff = await evaluate(`(function(){var c=__ytafFx.cases[${i}];var r=c.run();return {r:r,ok:!!c.expectOff(r)}})()`);
        const sOn = await setv(meta.key, meta.on);
        const rOn = await evaluate(`(function(){var c=__ytafFx.cases[${i}];var r=c.run();return {r:r,ok:!!c.expectOn(r)}})()`);
        for (const k of keys) await setv(k, orig[k] === undefined ? (k === meta.key ? meta.off : meta.needs[k]) : orig[k]);
        const ok = !!(sOff && sOff.ok && sOn && sOn.ok && rOff && rOff.ok && rOn && rOn.ok);
        fxResults.push({ name: meta.name, key: meta.key, ok, setOff: sOff, setOn: sOn, off: rOff, on: rOn });
        check(`effect: ${meta.name}`, ok, ok ? '' : JSON.stringify({ setOff: sOff, setOn: sOn, off: rOff, on: rOn }).slice(0, 300));
      }

      // The same on YouTube's REAL responses of this run: each filter off,
      // the real responses through our code; then on, the same responses again.
      const realCases = [
        { name: 'Ad Blocking', key: 'enableAdBlock', on: true, off: false, needs: {}, metric: 'ads' },
        { name: 'Reduce Telemetry & Tracking', key: 'enableTrackingBlock', on: true, off: false, needs: { enableAdBlock: true }, metric: 'tracking' },
        { name: 'Hide Endcards', key: 'hideEndcards', on: true, off: false, needs: { enableAdBlock: true }, metric: 'endscreen' },
        { name: 'Remove Shorts', key: 'removeGlobalShorts', on: true, off: false, needs: { enableAdBlock: true }, metric: 'shorts' },
        { name: 'Remove Live Videos', key: 'removeLiveVideos', on: true, off: false, needs: { enableAdBlock: true }, metric: 'live' },
        { name: 'Remove Upcoming Videos', key: 'removeUpcomingVideos', on: true, off: false, needs: { enableAdBlock: true }, metric: 'upcoming' },
        { name: 'Remove Members-Only Videos', key: 'removeMembersOnly', on: true, off: false, needs: { enableAdBlock: true }, metric: 'members' },
        { name: 'Hide Watched Videos', key: 'hideWatchedVideos', on: true, off: false, needs: { enableAdBlock: true }, metric: 'watched' },
        { name: 'Hide Videos Shorter Than 5 min', key: 'minVideoLength', on: '5', off: '0', needs: { enableAdBlock: true }, metric: 'under5min' },
        { name: 'Remove AI Videos (the videos the AI check learned)', key: 'removeAiVideos', on: true, off: false, needs: { enableAdBlock: true }, metric: 'ai' },
        { name: 'Blocked Channels (the feed\'s most frequent channel)', key: 'blockedChannels', on: '@channel', off: [], needs: { enableAdBlock: true }, metric: 'channel' },
        { name: 'Hide Videos Whose Title Contains (a word from a real title)', key: 'blockedKeywords', on: '@word', off: [], needs: { enableAdBlock: true }, metric: 'word' }
      ];
      const realResults = [];
      const nTexts = await evaluate('(window.__ytafReal&&window.__ytafReal.texts.length)||0');
      // None kept would leave the real-data checks out without a word.
      check('real data: YouTube responses kept for the replay', nTexts > 0, `${nTexts} kept`);
      for (const rc of realCases) {
        if (!nTexts) break;
        const keys = [rc.key].concat(Object.keys(rc.needs));
        const orig = {};
        for (const k of keys) orig[k] = await evaluate(`__ytafFx.get(${js(k)})`);
        const setv = async (k, v) => evaluate(`__ytafFx.set(${js(k)}, ${js(v)}).then(function(x){return JSON.stringify(x)})`);
        for (const k of Object.keys(rc.needs)) await setv(k, rc.needs[k]);
        await setv(rc.key, rc.off);
        const s0 = await evaluate('__ytafFx.replay()');
        let on = rc.on;
        let pick = null;
        if (on === '@channel') { pick = await evaluate(`__ytafFx.top(${js(s0.channels)})`); on = pick ? [pick] : []; }
        if (on === '@word') { pick = await evaluate(`__ytafFx.top(${js(s0.words)})`); on = pick ? [pick] : []; }
        await setv(rc.key, on);
        const s1 = await evaluate('__ytafFx.replay()');
        for (const k of keys) await setv(k, orig[k] === undefined ? (k === rc.key ? rc.off : rc.needs[k]) : orig[k]);
        const val = (s) => (rc.metric === 'channel' ? (s.channels[pick] || 0) : rc.metric === 'word' ? (s.words[pick] || 0) : s[rc.metric]);
        const a = val(s0); const b = val(s1);
        const verdict = a === 0 ? 'none in the real data' : b < a ? 'works' : 'NOT WORKING';
        realResults.push({ name: rc.name, key: rc.key, pick, off: a, on: b, items: [s0.items, s1.items], verdict,
          leftWhenOn: s1.samples && (rc.metric === 'watched' ? s1.samples.watched : rc.metric === 'under5min' ? s1.samples.under5min : rc.metric === 'ai' ? s1.samples.ai : undefined) });
        if (rc.metric === 'ai' && b > 0 && s1.samples && s1.samples.ai) log('AI videos left when on:', s1.samples.ai.join(' || '));
        if (a === 0) log(`real data: ${rc.name}: nothing of this kind in the ${s0.responses} real responses (${s0.items} videos)`);
        else check(`real data: ${rc.name}${pick ? ` [${pick}]` : ''}`, b < a, `off ${a} -> on ${b} (videos ${s0.items} -> ${s1.items})`);
      }

      // Every other setting: one press, and what changes on the page.
      const descKeys = Object.keys(descs);
      const caseKeys = fxResults.map((x) => x.key);
      const skip = ['perAccountSettings', 'checkForUpdates', 'showWhatsNew'];
      const visibleFx = [];
      for (const k of descKeys) {
        if (skip.includes(k) || caseKeys.includes(k)) continue;
        const type = await evaluate(`__ytafFx.find(${js(k)})`);
        if (type !== 'bool' && type !== 'cycle') { visibleFx.push({ key: k, type, note: 'no bool/cycle control' }); continue; }
        const v0 = await evaluate(`JSON.stringify(__ytafFx.get(${js(k)}))`);
        const f0 = await evaluate('JSON.stringify(__ytafFx.fp())');
        const exBefore = exceptions.length;
        await evaluate(`__ytafFx.step(${js(k)})`);
        await sleep(900);
        const v1 = await evaluate(`JSON.stringify(__ytafFx.get(${js(k)}))`);
        const f1 = await evaluate('JSON.stringify(__ytafFx.fp())');
        await evaluate(`__ytafFx.set(${js(k)}, ${v0 === undefined ? 'undefined' : js(JSON.parse(v0))})`);
        await sleep(600);
        const f2 = await evaluate('JSON.stringify(__ytafFx.fp())');
        const a = JSON.parse(f0); const b = JSON.parse(f1); const c2 = JSON.parse(f2);
        const changes = [];
        for (const part of ['html', 'body', 'rate', 'bg']) if (JSON.stringify(a[part]) !== JSON.stringify(b[part])) changes.push(`${part}: ${JSON.stringify(a[part])} -> ${JSON.stringify(b[part])}`);
        for (const part of ['els', 'styles']) {
          const ks = new Set(Object.keys(a[part]).concat(Object.keys(b[part])));
          for (const x of ks) if (a[part][x] !== b[part][x]) changes.push(`${part}.${x}: ${a[part][x] === undefined ? '-' : a[part][x]} -> ${b[part][x] === undefined ? '-' : b[part][x]}`);
        }
        const back = JSON.stringify(a.html) === JSON.stringify(c2.html) && JSON.stringify(a.body) === JSON.stringify(c2.body) && JSON.stringify(a.styles) === JSON.stringify(c2.styles);
        visibleFx.push({ key: k, type, from: v0, to: v1, changes, back, errors: exceptions.slice(exBefore) });
        log(`fx ${k}: ${v0} -> ${v1}:`, changes.length ? changes.join('; ').slice(0, 220) : 'no visible change', back ? '' : '(not back to the start)');
      }
      // The watch page's overlays: each off, then on, with the panel closed and
      // the player controls up; what they show must change.
      const overlayCases = [
        { key: 'timeRemainingMode', off: 'off', on: 'both', part: 'timeRemaining', name: 'Show Remaining Time / End Time' },
        { key: 'showMostReplayed', off: false, on: true, part: 'mostReplayed', name: 'Most Replayed graph' },
        { key: 'clockMode', off: 'off', on: 'time', part: 'clocks', name: 'Clock in UI' },
        { key: 'showWatchTime', off: false, on: true, part: 'clocks', name: 'Watch Time With the Clock', needs: { clockMode: 'time' }, offShows: true },
        { key: 'showQualityInTitle', off: false, on: true, part: 'qualityTag', name: 'Video Quality Next to the Title' }
      ];
      const ovResults = [];
      const panelSet = async (k, v) => {
        if (!(await evaluate(panelOpen))) { await key(404, 'Green'); await waitFor(panelOpen, 10000); }
        const r = await evaluate(`__ytafFx.set(${js(k)}, ${js(v)}).then(function(x){return JSON.stringify(x)})`);
        return typeof r === 'string' ? JSON.parse(r) : r;
      };
      // Closed for sure before the next key: on a slowed-down CPU the panel can
      // still be open 0.8 s after Back, and Up then moves inside the panel.
      const closePanel = async () => {
        for (let i = 0; i < 3 && await evaluate(panelOpen); i++) {
          await key(461, 'Back');
          await waitFor(`!(${panelOpen})`, 4000);
        }
        await sleep(500);
      };
      // The overlays draw only while the player controls are up: press Up (a real
      // key, then an in-page one) until they are, up to 5 times, then look.
      // The overlays draw only while the player controls are up, and YouTube
      // hides them again after a few seconds. A real key press (as a remote's)
      // brings them up; an in-page event did not keep them. Press Up, wait
      // for the controls, give the overlays their 1 s tick, then look.
      const snap = async () => {
        for (let i = 0; i < 5; i++) {
          await key(38, 'ArrowUp');
          const up = await waitFor('__ytafFx.overlays().controls', 2500);
          if (up) { await sleep(1200); const s = await evaluate('__ytafFx.overlays()'); if (s && s.controls) return s; }
        }
        return evaluate('__ytafFx.overlays()');
      };
      for (const oc of overlayCases) {
        const keys = [oc.key].concat(Object.keys(oc.needs || {}));
        const orig = {};
        for (const k of keys) orig[k] = await evaluate(`__ytafFx.get(${js(k)})`);
        for (const k of Object.keys(oc.needs || {})) await panelSet(k, oc.needs[k]);
        await panelSet(oc.key, oc.off);
        await closePanel();
        const sOff = await snap();
        await panelSet(oc.key, oc.on);
        await closePanel();
        const sOn = await snap();
        for (const k of keys) if (orig[k] !== undefined) await panelSet(k, orig[k]);
        await closePanel();
        const a = sOff && sOff[oc.part]; const b = sOn && sOn[oc.part];
        // Nothing shows when off, except the clock under Watch Time, which
        // then shows without the watch time.
        const ok = !!b && (oc.offShows ? JSON.stringify(a) !== JSON.stringify(b) : !a);
        ovResults.push({ name: oc.name, key: oc.key, off: a, on: b, ok });
        check(`overlay: ${oc.name} shows when on, not when off`, ok, `off=${JSON.stringify(a).slice(0, 90)} on=${JSON.stringify(b).slice(0, 90)} | controls up: off ${sOff && sOff.controls} on ${sOn && sOn.controls} | setting: off ${JSON.stringify(sOff && sOff.cfg[oc.key])} on ${JSON.stringify(sOn && sOn.cfg[oc.key])}`);
      }
      if (!(await evaluate(panelOpen))) { await key(404, 'Green'); await waitFor(panelOpen, 10000); }

      fs.writeFileSync(path.join(outDir, `${label}-effects.json`), JSON.stringify({ cases: fxResults, real: realResults, visible: visibleFx, overlays: ovResults }, null, 2));
      const withChange = visibleFx.filter((x) => x.changes && x.changes.length).length;
      const errs = visibleFx.filter((x) => x.errors && x.errors.length);
      log(`visible effects: ${withChange} of ${visibleFx.filter((x) => x.changes).length} settings change something on the page right away`);
      check('no errors while pressing each setting', errs.length === 0, errs.map((x) => x.key + ': ' + x.errors[0]).slice(0, 4).join(' || '));
    }
    await key(461, 'Back');
    await sleep(800);
  }

  // 6. Every setting through the panel, with a video playing: each checkbox
  // off and on again, each multi-value control through all its values. After
  // every click the stored configuration must change, with no exception.
  if (process.env.SWEEP === '1' && !(await evaluate(panelOpen))) {
    await key(404, 'Green');
  }
  const sweepPanel = process.env.SWEEP === '1' && await waitFor(panelOpen, 15000);
  if (process.env.SWEEP === '1') check('the panel opens for the settings sweep', !!sweepPanel);
  if (sweepPanel) {
    const cfgSnap = '(function(){var o={};Object.keys(localStorage).filter(function(k){return /^ytaf-configuration/.test(k)}).forEach(function(k){var c=JSON.parse(localStorage.getItem(k)||\'{}\');for(var x in c)o[k+\'::\'+x]=JSON.stringify(c[x])});return o})()';
    const diff = (x, y) => Object.keys(Object.assign({}, x, y)).filter((k) => x[k] !== y[k]).map((k) => k.split('::').pop() + '=' + y[k]);
    const nTabs = await evaluate('document.querySelectorAll(\'.ytaf-ui-container .ytaf-tab-btn\').length');
    const sweep = [];
    for (let ti = 0; ti < nTabs; ti++) {
      const tabName = await evaluate(`(function(){var t=document.querySelectorAll('.ytaf-ui-container .ytaf-tab-btn')[${ti}];t.click();return t.textContent.trim()})()`);
      await sleep(500);
      const pageSel = '.ytaf-ui-container .ytaf-settings-page[style*="block"], .ytaf-ui-container .ytaf-settings-page:not([style*="none"])';
      const nBoxes = await evaluate(`(function(){var p=document.querySelector('${pageSel}');return p?p.querySelectorAll('input[type=checkbox]:not([tabindex="-1"])').length:0})()`);
      for (let i = 0; i < nBoxes; i++) {
        const before = await evaluate(cfgSnap);
        const exBefore = exceptions.length;
        const label = await evaluate(`(function(){var p=document.querySelector('${pageSel}');var b=p.querySelectorAll('input[type=checkbox]:not([tabindex="-1"])')[${i}];var l=b.closest('label');var t=(l?l.innerText:b.parentNode.innerText||'').trim();if(b.disabled)return '[disabled] '+t;b.click();return t})()`);
        await sleep(400);
        const mid = await evaluate(cfgSnap);
        await evaluate(`(function(){var p=document.querySelector('${pageSel}');var b=p.querySelectorAll('input[type=checkbox]:not([tabindex="-1"])')[${i}];if(!b.disabled)b.click();return true})()`);
        await sleep(400);
        const after = await evaluate(cfgSnap);
        const changed = diff(before, mid);
        const restored = diff(before, after).length === 0;
        const ok = /^\[disabled\]/.test(label) || (changed.length > 0 && restored && exceptions.length === exBefore);
        sweep.push({ tab: tabName, label, changed, restored, ok, errors: exceptions.slice(exBefore) });
        if (!ok) log('SWEEP problem', tabName, '|', label, '| changed', changed.join(','), '| restored', restored, exceptions.slice(exBefore).join(' || '));
      }
      const nRows = await evaluate(`(function(){var p=document.querySelector('${pageSel}');return p?p.querySelectorAll('.shortcut-control-row').length:0})()`);
      for (let i = 0; i < nRows; i++) {
        const start = await evaluate(cfgSnap);
        const exBefore = exceptions.length;
        const label = await evaluate(`(function(){var p=document.querySelector('${pageSel}');var r=p.querySelectorAll('.shortcut-control-row')[${i}];var l=r.querySelector('.shortcut-label');return (l?l.textContent:r.innerText).trim().slice(0,60)})()`);
        const values = [];
        let back = false;
        for (let step = 0; step < 40; step++) {
          const v = await evaluate(`(function(){var p=document.querySelector('${pageSel}');var r=p.querySelectorAll('.shortcut-control-row')[${i}];var a=r.querySelectorAll('.arrow-btn');if(a.length<2)return null;a[a.length-1].click();var c=r.querySelector('.current-value');return c?c.textContent:''})()`);
          if (v === null) break;
          await sleep(300);
          values.push(v);
          if (diff(start, await evaluate(cfgSnap)).length === 0) { back = true; break; }
        }
        const ok = values.length === 0 || (back && exceptions.length === exBefore);
        sweep.push({ tab: tabName, label, values, back, ok, errors: exceptions.slice(exBefore) });
        if (!ok) log('SWEEP problem', tabName, '|', label, '| values', values.join(' > '), '| back to start', back, exceptions.slice(exBefore).join(' || '));
      }
      log('tab', tabName, ':', nBoxes, 'checkboxes,', nRows, 'other controls');
    }
    fs.writeFileSync(path.join(outDir, `${label}-sweep.json`), JSON.stringify(sweep, null, 2));
    const bad = sweep.filter((x) => !x.ok);
    check(`every setting changes and comes back (${sweep.length} controls)`, bad.length === 0, bad.map((x) => `${x.tab}/${x.label}`).slice(0, 8).join('; '));
    await key(461, 'Back');
    await sleep(1000);
    const still = await evaluate('(function(){var v=document.querySelector(\'video\');return v?{t:v.currentTime,paused:v.paused,page:(document.body.className.match(/WEB_PAGE_TYPE_\\w+/)||[\'\'])[0]}:null})()');
    log('after the sweep:', JSON.stringify(still));
    check('still on a working page after the sweep', !!still && !still.__error, JSON.stringify(still));
    await shot('6-after-sweep');
  }
  }

  // What our code took out of YouTube's real responses during the run.
  const real = await evaluate('window.__ytafReal');
  if (real && !real.__error) {
    log(`real YouTube responses: ${real.responses}; ads ${real.raw.ads} -> ${real.out.ads}, Shorts ${real.raw.shorts} -> ${real.out.shorts}, live ${real.raw.live} -> ${real.out.live}`);
    if (real.raw.ads > 0) check('real responses: the ads are taken out', real.out.ads === 0, `${real.raw.ads} -> ${real.out.ads}`);
  }
  const ai = await evaluate('(function(){var ids=[];try{ids=(JSON.parse(localStorage.getItem(\'ytaf-ai-videos\')||\'[]\')||[]).map(function(e){return e&&e.id})}catch(e){}return {badges:document.querySelectorAll(\'[data-ytaf-ai-badge]\').length,learned:ids.length}})()');
  log('AI: label lookups', requests.filter((u) => /youtubei\/v1\/next\?prettyPrint=false&fields=/.test(u)).length, '| AI badges on the page', ai && ai.badges, '| AI videos learned', ai && ai.learned);

  check('no uncaught exceptions', exceptions.length === 0, exceptions.slice(0, 5).join(' || '));
  if (consoleErrors.length) log('console errors:', consoleErrors.length, consoleErrors.slice(0, 5).join(' || '));
  check('the app stays open', !closed);
  fs.writeFileSync(path.join(outDir, `${label}-results.json`), JSON.stringify({ results, exceptions, consoleErrors }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  log(`${label}: ${results.length - failed}/${results.length} passed`);
  c.close();
  try {
    execSync(`taskkill /PID ${sim.pid} /T /F`, { stdio: 'ignore' });
  } catch {
    // already closed
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
