/**
 * The Queue row (long-press-menu.js queueShelf, put in by adblock.js): while
 * the queue has videos, a watch-next response gets a Queue row first under the
 * player, with a Clear queue tile and the queued videos, next first. Clear
 * queue empties it; a queued video that plays leaves the queue.
 *
 * Usage: node bench/queue-shelf-test.cjs [bundle] [legacy|modern]
 */
const { createReporter, bootPage, wait, UA } = require('./harness.cjs');

const { t, run } = createReporter();
const pad = 'z'.repeat(600);

function boot(cfg) {
  let NS;
  const resolved = [];
  const page = bootPage({
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    url: 'https://www.youtube.com/tv#/watch?v=current0001',
    userAgent: UA.webos23,
    ignoreNavigation: true,
    consoleErrors: false,
    config: Object.assign({
      enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
      enableReturnYouTubeDislike: false, thumbnailQuality: 'off', enableAutoLogin: false
    }, cfg),
    fetch: () => Promise.reject(new Error('offline')),
    setup: (w) => {
      NS = w.JSON.stringify;
      w._yttv = {
        resolver: Object.assign(function Resolver() {}, {
          instance: { resolveCommand: (cmd) => { resolved.push(cmd); return 'original'; } }
        })
      };
    }
  });
  const { win } = page;
  const parse = (obj) => win.JSON.parse(NS(obj));
  // A command through the TV app's resolver, as a tile or menu entry sends it.
  const command = (cmd) => win._yttv.resolver.instance.resolveCommand(cmd);
  const action = (name, params) => command({ playlistEditEndpoint: { ytafAction: { action: name, params } } });
  const state = (s, videoId) => win.dispatchEvent(new win.CustomEvent('yt-player-state-change', { detail: { state: s, videoId } }));
  return Object.assign(page, { parse, command, action, state, resolved });
}

const related = () => ({ shelfRenderer: { shelfHeaderRenderer: { title: { simpleText: 'Up next' } },
  content: { horizontalListRenderer: { items: [] } } } });
const watchNext = () => ({
  responseContext: { _pad: pad },
  contents: { singleColumnWatchNextResults: { pivot: { sectionListRenderer: { contents: [related()] } } } }
});
const rows = (r) => r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents;
const title = (row) => row.shelfRenderer && row.shelfRenderer.shelfHeaderRenderer.title.simpleText;
const tiles = (row) => row.shelfRenderer.content.horizontalListRenderer.items.map((i) => i.tileRenderer);

run(async () => {
  {
    const env = boot({});
    await wait(100);
    t('empty queue: no Queue row', rows(env.parse(watchNext())).map(title).join() === 'Up next');
    env.action('addToQueue', { videoId: 'aaaaaaaaaaa', title: 'First' });
    env.action('addToQueue', { videoId: 'bbbbbbbbbbb', title: 'Second' });
    const r = env.parse(watchNext());
    t('with videos: the Queue row comes first', rows(r).map(title).join() === 'Queue (2),Up next', rows(r).map(title).join());
    // webOS 25 draws a watch-page row only with its header in headerRenderer, as YouTube's own rows have it.
    const head = rows(r)[0].shelfRenderer.headerRenderer;
    t('...its header in headerRenderer too, where webOS 25 reads it',
      !!head && !!head.shelfHeaderRenderer && head.shelfHeaderRenderer.title.simpleText === 'Queue (2)', JSON.stringify(head));
    const row = tiles(rows(r)[0]);
    t('...a Clear queue tile, then the videos, next first',
      row.map((x) => x.metadata.tileMetadataRenderer.title.simpleText).join() === 'Clear queue,First,Second');
    t('...each video plays from its tile, with its thumbnail and id',
      row[1].onSelectCommand.watchEndpoint.videoId === 'aaaaaaaaaaa' && row[1].contentId === 'aaaaaaaaaaa' &&
      /\/vi\/aaaaaaaaaaa\/hqdefault\.jpg$/.test(row[1].header.tileHeaderRenderer.thumbnail.thumbnails[0].url));
    t('...the focus starts on the next video', rows(r)[0].shelfRenderer.content.horizontalListRenderer.selectedIndex === 1);
    const menu = row[2].onLongPressCommand && row[2].onLongPressCommand.showMenuCommand;
    t('...each video has its own long-press menu', !!menu && menu.contentId === 'bbbbbbbbbbb' &&
      menu.menu.menuRenderer.items[0].menuNavigationItemRenderer.navigationEndpoint.watchEndpoint.videoId === 'bbbbbbbbbbb',
      JSON.stringify(menu && menu.contentId));
    t('...Clear queue has none', !row[0].onLongPressCommand);

    // The watch page of a queued video, read before it plays: it is not on its own row.
    const opened = Object.assign(watchNext(), { currentVideoEndpoint: { watchEndpoint: { videoId: 'aaaaaaaaaaa' } } });
    const ownRow = rows(env.parse(opened))[0];
    t('the video the page opens is left off the row', title(ownRow) === 'Queue (1)' &&
      tiles(ownRow).slice(1).map((x) => x.contentId).join() === 'bbbbbbbbbbb', tiles(ownRow).map((x) => x.contentId).join());
    // The first queued video's preview plays behind Home: no turn, it stays.
    env.win.location.hash = '#/';
    env.state(1, 'aaaaaaaaaaa');
    await wait(20);
    t('a queued video\'s preview on Home leaves it in the queue', rows(env.parse(watchNext())).map(title).join() === 'Queue (2),Up next',
      rows(env.parse(watchNext())).map(title).join());
    // It plays on the watch page (from its tile): it leaves the queue.
    env.win.location.hash = '#/watch?v=aaaaaaaaaaa';
    env.state(1, 'aaaaaaaaaaa');
    await wait(20);
    t('a queued video that plays leaves the queue', rows(env.parse(watchNext())).map(title).join() === 'Queue (1),Up next');
    const left = tiles(rows(env.parse(watchNext()))[0]);
    t('...and the one left is the other video', left.length === 2 && left[1].contentId === 'bbbbbbbbbbb',
      left.map((x) => x.contentId).join());

    // Clear queue, as its tile sends it.
    const clear = tiles(rows(env.parse(watchNext()))[0])[0].onSelectCommand;
    env.command(clear);
    t('Clear queue empties it, and the row goes', rows(env.parse(watchNext())).map(title).join() === 'Up next');
    t('...the command went no further than the app', env.resolved.length === 0, JSON.stringify(env.resolved));
    t('no page error', env.errors.length === 0, env.errors[0]);
  }
  {
    // Hide Recommended Videos Under the Player and Ad Blocking off: the row still comes.
    const env = boot({ hideRecommendedVideos: true });
    await wait(100);
    env.action('addToQueue', { videoId: 'aaaaaaaaaaa', title: 'First' });
    t('with Hide Recommended Videos: the Queue row stays', title(rows(env.parse(watchNext()))[0]) === 'Queue (1)');
    const off = boot({ enableAdBlock: false });
    await wait(100);
    off.action('addToQueue', { videoId: 'aaaaaaaaaaa', title: 'First' });
    t('with Ad Blocking off too', title(rows(off.parse(watchNext()))[0]) === 'Queue (1)');
  }
});
