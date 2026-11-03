/**
 * The videos beside and under the player (the watch-next response's pivot) go
 * through the item filters on their own: Remove AI Videos, Remove Shorts and
 * the Live / Upcoming / Members-only badges each work there without a feed
 * filter turned on. Before, the pivot was only filtered when a feed filter,
 * the guest-prompt filter or the long-press entries were on, so a learned AI
 * video stayed beside the player (found in the webOS TV Simulators).
 *
 * Usage: node bench/pivot-filters-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';
const pad = 'z'.repeat(600);

function boot(cfg, aiIds) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_WATCH"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv#/watch?v=current0001', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos23);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.requestAnimationFrame = () => 0;
  win.cancelAnimationFrame = () => {};
  const NS = win.JSON.stringify;
  win.localStorage.setItem('ytaf-configuration', NS(Object.assign({
    enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false
  }, cfg)));
  // Videos ai-content-filter.js found labelled "AI" (ai-video-store.js).
  win.localStorage.setItem('ytaf-ai-videos', NS((aiIds || []).map((id) => ({ id, expiresAt: Date.now() + 864e5 }))));
  applyChrome38Downgrade(win);
  win.fetch = () => Promise.reject(new Error('offline'));
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { errors, parse: (obj) => win.JSON.parse(NS(obj)) };
}

function tile(id) {
  return { tileRenderer: { style: 'TILE_STYLE_YTLR_DEFAULT', contentType: 'TILE_CONTENT_TYPE_VIDEO', contentId: id,
    onSelectCommand: { watchEndpoint: { videoId: id } },
    header: { tileHeaderRenderer: { thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '10:00' } } }] } },
    metadata: { tileMetadataRenderer: { title: { simpleText: 'Video ' + id }, lines: [
      { lineRenderer: { items: [{ lineItemRenderer: { text: { runs: [{ text: 'Some Channel' }] } } }] } }] } } } };
}
function liveLockup(id) {
  return { lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [
      { thumbnailBadgeViewModel: { text: 'LIVE', badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' } }] } }] } },
    rendererContext: { commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: id } } } } } } };
}
function short(id) {
  return { reelItemRenderer: { videoId: id, navigationEndpoint: { reelWatchEndpoint: { videoId: id } } } };
}
// A premiere waiting to start: the time status says UPCOMING.
function upcomingTile(id) {
  const t = tile(id);
  t.tileRenderer.header.tileHeaderRenderer.thumbnailOverlays = [{ thumbnailOverlayTimeStatusRenderer: { style: 'UPCOMING' } }];
  return t;
}
// A members-only video: the badge in the lockup's metadata row.
function membersLockup(id) {
  return { lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: { lockupMetadataViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [
      { badges: [{ badgeViewModel: { badgeStyle: 'BADGE_STYLE_TYPE_MEMBERS_ONLY' } }] }] } } } },
    rendererContext: { commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: id } } } } } } };
}

// A watch-next response: a row of videos beside the player.
function next() {
  return {
    responseContext: { _pad: pad },
    currentVideoEndpoint: { watchEndpoint: { videoId: 'current0001' } },
    contents: { singleColumnWatchNextResults: { pivot: { sectionListRenderer: { contents: [
      { shelfRenderer: { title: { runs: [{ text: 'Up next' }] }, content: { horizontalListRenderer: { items: [
        tile('plainvideo1'), tile('aivideo0001'), short('shortvideo1'), liveLockup('livevideo01'),
        upcomingTile('upcoming001'), membersLockup('members0001'), tile('plainvideo2')
      ] } } } }
    ] } } } }
  };
}
const idsBeside = (r) => r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents[0]
  .shelfRenderer.content.horizontalListRenderer.items
  .map((i) => (i.tileRenderer || i.lockupViewModel || i.reelItemRenderer).contentId || (i.reelItemRenderer || {}).videoId);

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};

const ALL = ['plainvideo1', 'aivideo0001', 'shortvideo1', 'livevideo01', 'upcoming001', 'members0001', 'plainvideo2'];
const cases = [
  ['Remove AI Videos alone drops the learned AI video beside the player', { removeAiVideos: true }, 'aivideo0001'],
  ['Remove Shorts alone drops the Short beside the player', { removeGlobalShorts: true }, 'shortvideo1'],
  ['Remove Live Videos alone drops the live video beside the player', { removeLiveVideos: true }, 'livevideo01'],
  ['Remove Upcoming Videos alone drops the premiere beside the player', { removeUpcomingVideos: true }, 'upcoming001'],
  ['Remove Members-Only Videos alone drops the members-only video beside the player', { removeMembersOnly: true }, 'members0001']
];
// Exactly its own video goes: every other one, special or plain, stays.
for (const [name, cfg, gone] of cases) {
  const { parse, errors } = boot(cfg, ['aivideo0001']);
  const ids = idsBeside(parse(next()));
  const expected = ALL.filter((id) => id !== gone);
  t(name, JSON.stringify(ids) === JSON.stringify(expected), ids.join(','));
  t(name + ': no page errors', errors.length === 0, errors.join(' | '));
}
{
  const { parse } = boot({}, ['aivideo0001']);
  const ids = idsBeside(parse(next()));
  t('with these filters off every video beside the player stays', JSON.stringify(ids) === JSON.stringify(ALL), ids.join(','));
}
{
  const { parse } = boot({ enableAdBlock: false, removeAiVideos: true, removeGlobalShorts: true, removeLiveVideos: true,
    removeUpcomingVideos: true, removeMembersOnly: true }, ['aivideo0001']);
  const ids = idsBeside(parse(next()));
  t('with Ad Blocking off they do nothing, as elsewhere', JSON.stringify(ids) === JSON.stringify(ALL), ids.join(','));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
