// Hide Watched Videos on YouTube's real data, in a simulator left open by
//   STOP_AFTER_WATCH=1 node run-app-test.cjs <simulator .exe> <app dir>
// with a signed-in account that has a watch history:
//  a) the History page's real responses, the filter on: the watched videos
//     that stay must all be in the History (FEhistory), which keeps them on
//     purpose (adblock.js keepsWatchedVideos);
//  b) the same responses with their browse_id changed to the home feed: the
//     filter must take the watched videos out (YouTube's real watched marks).
//   node watched-check.cjs [port]
const fs = require('fs');
const path = require('path');
const { sleep, youtubePage, client, js, settingLabels } = require('./cdp.cjs');
const port = process.argv[2] || 9229;

(async () => {
  const t = await youtubePage(port);
  if (!t) throw new Error('no YouTube page on port ' + port);
  const c = client(t.webSocketDebuggerUrl);
  const ev = c.evaluate;
  await ev(`window.__ytafDescs=${js(settingLabels())};${fs.readFileSync(path.join(__dirname, 'effects-page.js'), 'utf8')};window.__ytafReal.texts=[];true`);

  console.log('opening the History...');
  await ev('location.hash=\'#/browse?c=FEhistory\';true');
  await sleep(10000);
  console.log('responses kept:', await ev('window.__ytafReal.texts.length'));

  await c.key(404, 'Green');
  await sleep(3000);
  const set = (k, v) => ev(`__ytafFx.set(${js(k)}, ${js(v)}).then(function(r){return JSON.stringify(r)})`);
  // a) the History keeps its watched videos: the count stays; b) as the home
  // feed the filter takes them out: the count drops. Exit 1 when one does
  // not, or when there are no watched videos to tell.
  const compare = async (name, keepsWatched) => {
    await set('hideWatchedVideos', false);
    const off = await ev('__ytafFx.replay()');
    await set('hideWatchedVideos', true);
    const on = await ev('__ytafFx.replay()');
    console.log(`${name}: watched videos ${off.watched} -> ${on.watched} (videos ${off.items} -> ${on.items})`);
    console.log('   left:', JSON.stringify(((on.samples || {}).watched || []).slice(0, 6)));
    if (typeof off.watched !== 'number' || typeof on.watched !== 'number' || off.watched === 0) {
      console.log('   INCONCLUSIVE: no watched videos in the responses (an account with a watch history?)');
      process.exitCode = 1;
      return;
    }
    const pass = keepsWatched ? on.watched === off.watched : on.watched < off.watched;
    console.log(pass ? '   PASS' : '   FAIL: ' + (keepsWatched ? 'the History lost watched videos' : 'the filter did not take the watched videos out'));
    if (!pass) process.exitCode = 1;
  };
  // The two settings as they were, afterwards, also when a step fails.
  const before = { enableAdBlock: await ev('__ytafFx.get("enableAdBlock")'), hideWatchedVideos: await ev('__ytafFx.get("hideWatchedVideos")') };
  try {
    await set('enableAdBlock', true);
    await compare('a) History as sent', true);
    await ev('(function(){var R=window.__ytafReal;R.texts=R.texts.map(function(t){return t.split(\'FEhistory\').join(\'FEwhat_to_watch\')});return 1})()');
    await compare('b) the same, as the home feed', false);
  } finally {
    for (const k of Object.keys(before)) if (typeof before[k] === 'boolean') await set(k, before[k]);
    c.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
