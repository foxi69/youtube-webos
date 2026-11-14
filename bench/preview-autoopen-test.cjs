/**
 * Tile previews never open full screen by themselves: every preview command's
 * autotransitionDelayMs becomes -1 and its forceSeamlessAutotransition false,
 * with no setting and every other use of the JSON.parse hook off
 * (adblock.js, stopPreviewAutoOpen). And Mute Video Previews mutes again when
 * YouTube unmutes the video on a volume change (mute-previews.js).
 *
 * The field values are a webOS 25 TV's (2026-11-14): the preview starts 3 s
 * after focus, opens the video at 39 s and ends at 40 s.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';

// Every setting that once kept the JSON.parse hook installed, off.
const ALL_OFF = {
  enableAdBlock: false, enableTrackingBlock: false, removeGlobalShorts: false,
  removeLiveVideos: false, removeAiVideos: false, markAiVideos: false, removeTopLiveGames: false,
  removeMostRelevant: false, hideGuestSignInPrompts: false, hideEndcards: false,
  enableLegacyEmojiFix: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
  upgradeThumbnails: false, enableAutoLogin: false, loadRowsAhead: false,
  disableAutoCaptions: false, forceOriginalAudio: false, extendLongPressMenu: false,
  enableDeArrow: false, hiddenSidebarEntries: [], mutePreviews: false
};

const pad = 'z'.repeat(600);

// A preview command as the TV gets it; `delay` and `seamless` vary per case.
const command = (id, delay, seamless) => {
  const c = {
    playbackEndpoint: { watchEndpoint: { videoId: id } },
    playbackBehavior: { caption: false, muted: false },
    delayMs: 3000, blockAdoption: true, resumeVideo: true, restartPlaybackBeforeSeconds: 10,
    durationMs: 40000, autotransitionDelayMs: delay, blockAdoptionFromWatch: true, uncapInlineQuality: true
  };
  if (seamless !== undefined) c.forceSeamlessAutotransition = seamless;
  return c;
};

// A tile with its command `wrap` levels further down than the real one.
const tile = (id, delay, seamless, wrap) => {
  let focus = { startInlinePlaybackCommand: command(id, delay, seamless) };
  for (let i = 0; i < wrap; i++) focus = { commandExecutorCommand: { commands: [focus] } };
  return { tileRenderer: { contentId: id, onFocusCommand: focus } };
};

const shelves = (tiles) => ({ sectionListRenderer: { contents: [
  { shelfRenderer: { content: { horizontalListRenderer: { items: tiles.slice(0, 2) } } } },
  { shelfRenderer: { content: { horizontalListRenderer: { items: tiles.slice(2) } } } }
] } });

const browse = (tiles) => ({
  responseContext: { _pad: pad },
  contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: shelves(tiles) } } } }
});

// Every preview command in a parsed response, in the order met.
function commands(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.startInlinePlaybackCommand) out.push(node.startInlinePlaybackCommand);
  for (const k in node) commands(node[k], out);
  return out;
}

function boot(cfg, early) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String(e && e.message)));
  const dom = new JSDOM(
    '<!doctype html><html><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.requestAnimationFrame = () => 0;
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', win.JSON.stringify(cfg));
  // The first home screen, parsed by YouTube's page before the userScript ran.
  if (early) win.pendingEarlyBrowse = win.Promise.resolve({ response: win.JSON.parse(win.JSON.stringify(early)) });
  applyChrome38Downgrade(win);
  win.fetch = () => Promise.reject(new Error('offline'));
  const nativeParse = win.JSON.parse;
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, errors, nativeParse };
}

let pass = 0, fail = 0;
const t = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); } };
const tick = (win, ms = 0) => new Promise((r) => win.setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);

async function responses() {
  const early = browse([tile('eeeeeeeeee1', 39000, true, 0), tile('eeeeeeeeee2', 39000, true, 3)]);
  const { win, errors, nativeParse } = boot(ALL_OFF, early);
  const P = (obj) => win.JSON.parse(win.JSON.stringify(obj));

  t('precondition: the hook is in place with every setting off', win.JSON.parse !== nativeParse);

  // Home: number and string delays, at the real depths (16 and 19 on the TV)
  // and at the walk's limit, depth 40 (wrap 8).
  const home = P(browse([
    tile('aaaaaaaaaa1', 39000, true, 0), tile('aaaaaaaaaa2', '39000', true, 3),
    tile('aaaaaaaaaa3', 39000, true, 8), tile('aaaaaaaaaa4', 0, true, 1)
  ]));
  const h = commands(home);
  t('home: four commands found', h.length === 4, 'got ' + h.length);
  t('home: every autotransitionDelayMs is -1', h.length === 4 && h.every((c) => c.autotransitionDelayMs === -1),
    JSON.stringify(h.map((c) => c.autotransitionDelayMs)));
  t('home: every forceSeamlessAutotransition is false', h.length === 4 && h.every((c) => c.forceSeamlessAutotransition === false),
    JSON.stringify(h.map((c) => c.forceSeamlessAutotransition)));
  t('home: the rest of each command is kept', h.length === 4 && h.every((c) =>
    c.durationMs === 40000 && c.delayMs === 3000 && c.blockAdoption === true && c.blockAdoptionFromWatch === true &&
    c.resumeVideo === true && c.playbackEndpoint.watchEndpoint.videoId.indexOf('aaaaaaaaaa') === 0),
  JSON.stringify(h[0]));

  // One level past the limit (depth 43): left as it is, the walk stops at 40.
  const deep = commands(P(browse([tile('dddddddddd1', 39000, true, 9)])));
  t('past the depth limit: left unchanged', deep.length === 1 && deep[0].autotransitionDelayMs === 39000 &&
    deep[0].forceSeamlessAutotransition === true, JSON.stringify(deep[0]));

  // A continuation (the next rows) goes through the same filter.
  const cont = P({ responseContext: { _pad: pad }, continuationContents: { horizontalListContinuation: {
    items: [tile('cccccccccc1', 39000, true, 0)] } } });
  const c = commands(cont);
  t('continuation: the delay is -1 and the seamless flag false', c.length === 1 &&
    c[0].autotransitionDelayMs === -1 && c[0].forceSeamlessAutotransition === false, JSON.stringify(c[0]));

  // No seamless flag in the command: none is added.
  const noFlag = commands(P(browse([tile('nnnnnnnnnn1', 39000, undefined, 0)])));
  t('no seamless flag: the delay is -1 and no flag is added', noFlag.length === 1 &&
    noFlag[0].autotransitionDelayMs === -1 && !('forceSeamlessAutotransition' in noFlag[0]), JSON.stringify(noFlag[0]));

  // A seamless flag already false stays false (not set to anything else).
  const off = commands(P(browse([tile('ffffffffff1', 39000, false, 0)])));
  t('seamless flag already false: stays false', off.length === 1 && off[0].forceSeamlessAutotransition === false &&
    off[0].autotransitionDelayMs === -1, JSON.stringify(off[0]));

  // Controls: a response without the field, and a stored value that is no response.
  const plain = browse([{ tileRenderer: { contentId: 'pppppppppp1', forceSeamlessAutotransition: true } }]);
  const parsedPlain = P(plain);
  t('control: a response without autotransitionDelayMs is unchanged',
    JSON.stringify(parsedPlain) === JSON.stringify(plain), JSON.stringify(parsedPlain).slice(0, 200));
  const stored = { _pad: pad, item: command('ssssssssss1', 39000, true) };
  const parsedStored = P(stored);
  t('control: an object that is no InnerTube response is unchanged',
    parsedStored.item.autotransitionDelayMs === 39000 && parsedStored.item.forceSeamlessAutotransition === true,
    JSON.stringify(parsedStored.item));

  // The first home screen, parsed before the hook: rewritten in place once the bundle runs.
  const earlyResponse = await withTimeout(win.pendingEarlyBrowse, 2000, 'early browse');
  for (let i = 0; i < 20 && commands(earlyResponse.response)[0]?.autotransitionDelayMs !== -1; i++) await tick(win, 10);
  const e = commands(earlyResponse.response);
  t('early browse: both commands rewritten', e.length === 2 &&
    e.every((x) => x.autotransitionDelayMs === -1 && x.forceSeamlessAutotransition === false), JSON.stringify(e));

  t('no page errors', errors.length === 0, errors.join(' | '));
}

async function mute() {
  const run = async (mutePreviews) => {
    const { win, errors } = boot(Object.assign({}, ALL_OFF, { mutePreviews }));
    const video = win.document.createElement('video');
    win.document.body.appendChild(video);
    const fire = (type) => video.dispatchEvent(new win.Event(type));
    fire('playing');
    const afterPlaying = video.muted;
    // YouTube writes its own unmuted state back with a volume change.
    video.muted = false;
    fire('volumechange');
    const afterVolume = video.muted;
    // The preview opened: on the watch page the mute is undone and stays undone.
    win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
    for (let i = 0; i < 20 && video.muted; i++) await tick(win, 5);
    const onWatch = video.muted;
    video.muted = false;
    fire('volumechange');
    return { afterPlaying, afterVolume, onWatch, watchAfterVolume: video.muted, errors };
  };

  const on = await run(true);
  t('mute on: playing mutes the preview (precondition)', on.afterPlaying === true);
  t('mute on: a volume change that unmutes the preview mutes it again', on.afterVolume === true);
  t('mute on: on the watch page the mute is undone', on.onWatch === false);
  t('mute on: a volume change on the watch page leaves the sound on', on.watchAfterVolume === false);
  t('mute on: no page errors', on.errors.length === 0, on.errors.join(' | '));

  const offRun = await run(false);
  t('control, mute off: playing leaves the sound on', offRun.afterPlaying === false);
  t('control, mute off: a volume change leaves the sound on', offRun.afterVolume === false);
}

(async () => {
  await responses();
  await mute();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
