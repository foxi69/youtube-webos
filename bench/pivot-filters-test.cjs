/**
 * The videos beside and under the player (the watch-next response's pivot) go
 * through the item filters on their own: Remove AI Videos, Remove Shorts and
 * the Live / Upcoming / Members-only badges each work there without a feed
 * filter turned on. Before, the pivot was only filtered when a feed filter,
 * the guest-prompt filter or the long-press entries were on, so a learned AI
 * video stayed beside the player (found in the webOS TV Simulators).
 *
 *   node bench/pivot-filters-test.cjs <bundle> [legacy|modern]
 *
 * `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87
 * environment, instead of the legacy one in a Chrome 38 one. Both run with a
 * webOS 23 user agent.
 */
const { createReporter, bootPage, UA } = require('./harness.cjs');

const pad = 'z'.repeat(600);

function boot(cfg, aiIds) {
  // The page's own JSON.stringify, from before the bundle hooks it.
  let NS;
  const { win, errors } = bootPage({
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    url: 'https://www.youtube.com/tv#/watch?v=current0001',
    userAgent: UA.webos23,
    consoleErrors: false,
    config: Object.assign({
      enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
      enableReturnYouTubeDislike: false, thumbnailQuality: 'off', enableAutoLogin: false
    }, cfg),
    // Videos ai-content-filter.js found labelled "AI" (ai-video-store.js).
    storage: { 'ytaf-ai-videos': JSON.stringify((aiIds || []).map((id) => ({ id, expiresAt: Date.now() + 864e5 }))) },
    // No frame ever runs.
    raf: 'none',
    setup(win) { NS = win.JSON.stringify; },
    fetch: () => Promise.reject(new Error('offline')),
    // The legacy page stays without Element#remove, as before this test moved
    // to the harness.
    restoreRemove: false
  });
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

const { t, done } = createReporter();

const ALL = ['plainvideo1', 'aivideo0001', 'shortvideo1', 'livevideo01', 'upcoming001', 'members0001', 'plainvideo2'];
const cases = [
  ['Remove AI Videos alone drops the learned AI video beside the player', { aiVideos: 'remove' }, 'aivideo0001'],
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
  const { parse } = boot({ enableAdBlock: false, aiVideos: 'remove', removeGlobalShorts: true, removeLiveVideos: true,
    removeUpcomingVideos: true, removeMembersOnly: true }, ['aivideo0001']);
  const ids = idsBeside(parse(next()));
  t('with Ad Blocking off they do nothing, as elsewhere', JSON.stringify(ids) === JSON.stringify(ALL), ids.join(','));
}

done();
