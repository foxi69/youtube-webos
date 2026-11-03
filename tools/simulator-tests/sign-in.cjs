// Brings a running simulator's YouTube to its sign-in screen (past the
// welcome screen, a video, which asks who is watching, then "Add account"),
// and prints the screen's text: the code to enter at yt.be/activate.
// Start the simulator first with STOP_AFTER_WATCH=1 run-app-test.cjs, or by hand
// with --remote-debugging-port.
//   node sign-in.cjs [port]
const { sleep, youtubePage, client, PAGE_KEY } = require('./cdp.cjs');
const port = process.argv[2] || 9229;

(async () => {
  const t = await youtubePage(port, 60000);
  if (!t) throw new Error('no YouTube page on port ' + port);
  const c = client(t.webSocketDebuggerUrl);
  const page = async () => String(await c.evaluate('(document.body&&document.body.className.match(/WEB_PAGE_TYPE_\\w+/)||[\'\'])[0]'));
  const ok = () => c.evaluate(`(function(){${PAGE_KEY}k(13,'Enter');return 1})()`);
  for (let i = 0; i < 12 && /WELCOME/.test(await page()); i++) {
    await ok();
    await sleep(5000);
  }
  await c.evaluate('location.hash=\'#/watch?v=aqz-KE-bpKQ\';1');
  await sleep(8000);
  const focused = await c.evaluate('(function(){var f=document.querySelectorAll(\'.zylon-focus\');var d=f[f.length-1];return d?(d.innerText||\'\').trim():\'\'})()');
  // "Add account" is focused first on a profile without accounts. Its label
  // is matched in English and Hungarian; in another UI language, press OK on
  // it yourself (node cdp.cjs <port> key Enter) and run this again.
  if (/ACCOUNT_SELECTOR/.test(await page())) {
    if (/hozzáadása|add account/i.test(focused)) {
      await ok();
      await sleep(5000);
    } else {
      console.log(`focused: "${focused.split('\n')[0]}". If that is "Add account" in your UI language, press OK on it: node cdp.cjs ${port} key Enter`);
    }
  }
  console.log('page:', await page());
  console.log('text:', await c.evaluate('(document.body.innerText||\'\').replace(/\\s+/g,\' \').slice(0,300)'));
  c.close();
})().catch((e) => { console.error(String(e)); process.exit(1); });
