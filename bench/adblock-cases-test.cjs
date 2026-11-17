/**
 * The JSON.parse filter (adblock.js) on the response shapes and settings the
 * other tests leave out: the Shorts player's own sequence of ads, responses
 * on the Shorts page (left whole), a large response of no known shape (the
 * fallback search), a watch-next page with a continuation and actions beside
 * it, the badges of the older video renderers, a player response wrapped
 * around another, Prefer Original Audio by the formats' xtags, the legacy
 * emoji fix on attributed text (the run offsets moved with it), a tab
 * placeholder without trackingParams of its own, the telemetry XHR block,
 * and Ad Blocking and Tracking Block switched off and on in the panel.
 *
 *   node bench/adblock-cases-test.cjs <bundle> [legacy|modern]
 *
 * Legacy runs as webOS 3, where the emoji fix is on; modern as webOS 23,
 * where it must change nothing.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, trustedKey, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();

const GREEN = 404;
const pad = 'z'.repeat(600);   // over the filter's 500-byte gate
const OPEN = '​', CLOSE = '‌';
const SMILE = '😀';

const { t, run } = createReporter();

const tile = (id, extra = {}) => ({ tileRenderer: Object.assign({ style: 'TILE_STYLE_YTLR_DEFAULT', contentId: id,
  onSelectCommand: { watchEndpoint: { videoId: id } } }, extra) });
const ad = () => ({ adSlotRenderer: { id: 'ad' } });
const ids = (items) => (items || []).map((i) => (i.tileRenderer ? i.tileRenderer.contentId : Object.keys(i)[0])).join(',');
const shelf = (items) => ({ shelfRenderer: { content: { horizontalListRenderer: { items } } } });
const xtags = (text) => Buffer.from(text, 'latin1').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function boot(cfg = {}, opts = {}) {
  // The TV's XMLHttpRequest, recording what it is asked.
  const xhr = [];
  const XHR = class XMLHttpRequest {
    open(...args) { xhr.push(['open'].concat(args)); }
    send(...args) { xhr.push(['send'].concat(args)); }
    setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {}
  };
  const { win, doc, errors, evaluate } = bootPage({
    code,
    bodyClass: opts.page || 'WEB_PAGE_TYPE_BROWSE',
    url: 'https://www.youtube.com/tv#/',
    ignoreNavigation: true,
    xhr: XHR,
    config: Object.assign({
      enableAdBlock: true, enableTrackingBlock: true, removeGlobalShorts: true, removeLiveVideos: true,
      removeUpcomingVideos: true, removeMembersOnly: true, hideEndcards: true, enableAutoLogin: true,
      subtitlesAtStart: 'off', forceOriginalAudio: true, enableLegacyEmojiFix: true,
      enableSponsorBlock: false, enableReturnYouTubeDislike: false, enableDeArrow: false,
      thumbnailQuality: 'off', checkForUpdates: false, showWhatsNew: false
    }, cfg),
    fetch: 'pending',
    evaluate: false
  });
  // The page's own JSON.stringify, before the bundle wraps it.
  const NS = win.JSON.stringify;
  evaluate();
  const P = (obj) => win.JSON.parse(NS(obj));
  return { win, doc, errors, xhr, P, XHR: win.XMLHttpRequest };
}

// A switch of the settings panel, by its label, set to `on`.
function setSwitch(win, label, on) {
  const doc = win.document;
  if (!doc.querySelector('.ytaf-ui-container')) {
    trustedKey(win, GREEN);
  }
  const panel = doc.querySelector('.ytaf-ui-container');
  for (let i = 0; i < 20; i++) panel.ensurePage(i);
  const row = Array.prototype.find.call(panel.querySelectorAll('label'), (l) => l.textContent.trim() === label);
  if (!row) throw new Error('no "' + label + '" switch in the panel');
  const input = row.querySelector('input');
  if (input.checked !== on) {
    input.checked = on;
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;
  const env = boot({ blockedKeywords: ['  SPOILER ', 7, '', null], blockedChannels: 'not a list' });
  await wait(30);
  const { P } = env;

  // ---- The Shorts player's sequence ----
  {
    const r = P({ responseContext: { _pad: pad }, entries: [
      { command: { reelWatchEndpoint: { videoId: 'short000001' } } },
      { command: { reelWatchEndpoint: { videoId: 'adshort0001', adClientParams: { isAd: 'true' } } } },
      { command: { reelWatchEndpoint: { videoId: 'adshort0002', adClientParams: { isAd: true } } } },
      { command: { reelWatchEndpoint: { videoId: 'adshort0003', videoType: 'REEL_VIDEO_TYPE_AD' } } },
      { command: { reelWatchEndpoint: { videoId: 'short000002' } } }
    ] });
    t(n('Shorts sequence: the ads among the Shorts go, the Shorts stay'),
      r.entries.map((e) => e.command.reelWatchEndpoint.videoId).join() === 'short000001,short000002',
      JSON.stringify(r.entries.map((e) => e.command.reelWatchEndpoint.videoId)));
    const notList = P({ responseContext: { _pad: pad }, entries: { adSlotRenderer: {} } });
    t(n('entries that are no list: left as sent'), !!notList.entries.adSlotRenderer);
  }

  // ---- Feed filter lists with junk in them ----
  {
    const r = P({ responseContext: { _pad: pad }, contents: { sectionListRenderer: { contents: [shelf([
      tile('keepme00001', { metadata: { tileMetadataRenderer: { title: { simpleText: 'A cooking video' } } } }),
      tile('spoiler0001', { metadata: { tileMetadataRenderer: { title: { simpleText: 'Big Spoiler inside' } } } })
    ])] } } });
    const items = r.contents.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items;
    t(n('a blocked-words list with blanks and non-words: the words in it still apply, trimmed and in any case'),
      ids(items) === 'keepme00001', ids(items));
  }

  // ---- A large response of no known shape: the fallback search ----
  {
    const big = 'b'.repeat(11000);
    const r = P({ responseContext: { _pad: big }, wrapper: {
      sectionListRenderer: { contents: [shelf([ad(), tile('fbshelf0001')]), { adSlotRenderer: {} }] },
      gridRenderer: { items: [ad(), tile('fbgrid00001'), tile('fbshort0001', { style: 'TILE_STYLE_YTLR_SHORTS' })] },
      inner: {
        gridContinuation: { items: [tile('fbgcont0001'), ad()] },
        sectionListContinuation: { contents: [shelf([tile('fbscont0001'), ad()])] },
        pivot: { sectionListRenderer: { contents: [shelf([ad(), tile('fbpivot0001')])] } },
        playerOverlayRenderer: { timelyActionRenderers: [{ qr: 1 }], other: 1 }
      }
    }, adPlacements: [{ ad: 1 }], endscreen: { cards: [] } });
    const w = r.wrapper;
    t(n('fallback: the section list\'s shelf and bare ad filtered'),
      w.sectionListRenderer.contents.length === 1 && ids(w.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items) === 'fbshelf0001',
      JSON.stringify(w.sectionListRenderer.contents).slice(0, 200));
    t(n('fallback: a grid\'s ad and Short removed'), ids(w.gridRenderer.items) === 'fbgrid00001', ids(w.gridRenderer.items));
    t(n('fallback: grid and section continuations filtered'), ids(w.inner.gridContinuation.items) === 'fbgcont0001' &&
      ids(w.inner.sectionListContinuation.contents[0].shelfRenderer.content.horizontalListRenderer.items) === 'fbscont0001');
    t(n('fallback: the videos beside the player filtered'),
      ids(w.inner.pivot.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items) === 'fbpivot0001');
    t(n('fallback: the QR codes over the player removed, the overlay kept'),
      !w.inner.playerOverlayRenderer.timelyActionRenderers && w.inner.playerOverlayRenderer.other === 1);
    t(n('fallback: the player ads and the endscreen go'), r.adPlacements.length === 0 && !r.endscreen);
  }
  {
    // A nested entries list.
    const r = P({ responseContext: { _pad: 'b'.repeat(11000) }, wrapper: { inner: { entries: [ad(), tile('fbentry0001')] } } });
    t(n('fallback: a nested entries list filtered'), ids(r.wrapper.inner.entries) === 'fbentry0001', ids(r.wrapper.inner.entries));
  }
  {
    // ...with a list met first, higher up: a list's own entries() method,
    // inherited from Array.prototype, is no entries list.
    const r = P({ responseContext: { _pad: 'b'.repeat(11000) }, list: [1, 2],
      wrapper: { inner: { entries: [ad(), tile('fbentry0002')] } } });
    t(n('fallback: a nested entries list filtered with a list above it'), ids(r.wrapper.inner.entries) === 'fbentry0002',
      ids(r.wrapper.inner.entries));
  }
  {
    // Under 10 kB with no known shape: only the guide entries are looked at.
    const r = P({ responseContext: { _pad: pad }, wrapper: { gridRenderer: { items: [ad(), tile('smallgrid01')] } } });
    t(n('a small response of no known shape is left alone'), r.wrapper.gridRenderer.items.length === 2);
  }

  // ---- Ad Blocking the only filter: the videos beside the player too ----
  {
    const { P: P2 } = boot({ removeGlobalShorts: false, removeLiveVideos: false, removeUpcomingVideos: false,
      removeMembersOnly: false, enableLegacyEmojiFix: false });
    const r = P2({ responseContext: { _pad: pad },
      contents: { singleColumnWatchNextResults: { pivot: { sectionListRenderer: { contents: [shelf([ad(), tile('onlyad00001')])] } } } } });
    const items = r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items;
    t(n('only Ad Blocking on: the ad beside the player goes'), ids(items) === 'onlyad00001', ids(items));
  }

  // ---- A watch-next page with a continuation and actions beside it ----
  {
    const r = P({ responseContext: { _pad: pad },
      contents: { singleColumnWatchNextResults: { results: { title: { simpleText: 'Party ' + SMILE } },
        pivot: { sectionListRenderer: { contents: [shelf([
          { compactVideoRenderer: { videoId: 'upcoming001', upcomingEventData: { startTime: '1' } } },
          { videoRenderer: { videoId: 'members0001', badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY' } }] } },
          { gridVideoRenderer: { videoId: 'upcoming002', badges: [{ metadataBadgeRenderer: { style: 'UPCOMING' } }] } },
          { videoRenderer: { videoId: 'plain000001', badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED' } }, null] } }
        ])] } } } },
      playerOverlays: { playerOverlayRenderer: { title: { runs: [{ text: 'Overlay ' + SMILE }] } } },
      engagementPanels: [{ panel: { header: { simpleText: 'Panel ' + SMILE } } }],
      continuationContents: { gridContinuation: { items: [ad(), tile('nextcont001')] } },
      onResponseReceivedActions: [null, { appendContinuationItemsAction: { continuationItems: [tile('nextact0001'), ad()] } }],
      onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [ad(), tile('nextend0001')] } }]
    });
    const pivot = r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items;
    t(n('beside the player: an upcoming video, a members-only one and an upcoming premiere of the older renderers go'),
      pivot.length === 1 && pivot[0].videoRenderer.videoId === 'plain000001', JSON.stringify(pivot.map((i) => Object.keys(i)[0])));
    t(n('a continuation beside the page is filtered'), ids(r.continuationContents.gridContinuation.items) === 'nextcont001');
    t(n('received actions and endpoints beside the page are filtered'),
      ids(r.onResponseReceivedActions[1].appendContinuationItemsAction.continuationItems) === 'nextact0001' &&
      ids(r.onResponseReceivedEndpoints[0].reloadContinuationItemsCommand.continuationItems) === 'nextend0001' &&
      r.onResponseReceivedActions[0] === null);
    const title = r.contents.singleColumnWatchNextResults.results.title;
    const overlay = r.playerOverlays.playerOverlayRenderer.title.runs;
    const panelHeader = r.engagementPanels[0].panel.header;
    if (modern) {
      t(n('webOS 23: the emoji in the watch page are left as they are'), title.simpleText === 'Party ' + SMILE &&
        overlay[0].text === 'Overlay ' + SMILE && panelHeader.simpleText === 'Panel ' + SMILE);
    } else {
      t(n('webOS 3: the emoji in the title, the overlay and the side panels are wrapped'),
        !!title.runs && title.runs[1].text === OPEN + SMILE + CLOSE &&
        overlay[1] && overlay[1].text === OPEN + SMILE + CLOSE &&
        !!panelHeader.runs && panelHeader.runs[1].text === OPEN + SMILE + CLOSE,
      JSON.stringify([title, overlay, panelHeader]));
    }
  }

  // ---- A player response with another one inside ----
  {
    const audioFormats = () => [
      { itag: 137, mimeType: 'video/mp4' },
      { itag: 140, audioTrack: { id: 'en.4', audioIsDefault: false }, xtags: xtags('\n\u0015\n\u0005acont\u0012\boriginal') },
      { itag: 251, audioTrack: { id: 'en.4', audioIsDefault: false } },
      { itag: 141, audioTrack: { id: 'de.3', audioIsDefault: true }, xtags: xtags('\n\u0013\n\u0005acont\u0012\u0006dubbed') },
      { itag: 249, audioTrack: { id: 'fr.3', audioIsDefault: false }, xtags: '%%%not-base64' },
      null
    ];
    const inner = () => ({
      adPlacements: [{ a: 1 }], playerAds: [{ a: 1 }], adSlots: [{ a: 1 }],
      endscreen: { cards: 1 }, paidContentOverlay: { text: 'Includes paid promotion' },
      messages: [{ youThereRenderer: {} }, { mealbarPromoRenderer: {} }, { youThereRenderer: {} }],
      captions: { playerCaptionsTracklistRenderer: { audioTracks: [{ defaultCaptionTrackIndex: 0, captionsInitialState: 'CAPTIONS_INITIAL_STATE_ON_REQUIRED' }, null] } },
      streamingData: { adaptiveFormats: audioFormats() }
    });
    const r = P(Object.assign({ responseContext: { _pad: pad }, playerResponse: inner() }, inner()));
    for (const [name, holder] of [['the response', r], ['the response inside it', r.playerResponse]]) {
      t(n(`player, ${name}: ads, endscreen and paid promotion banner gone`), holder.adPlacements.length === 0 &&
        holder.playerAds.length === 0 && holder.adSlots.length === 0 && !holder.endscreen && !holder.paidContentOverlay,
      JSON.stringify(Object.keys(holder)));
      t(n(`player, ${name}: "Are you still watching?" gone, other messages kept`),
        holder.messages.length === 1 && !!holder.messages[0].mealbarPromoRenderer);
      const track = holder.captions.playerCaptionsTracklistRenderer.audioTracks[0];
      t(n(`player, ${name}: subtitles do not start by themselves`), track.defaultCaptionTrackIndex === undefined &&
        track.captionsInitialState === 'CAPTIONS_INITIAL_STATE_OFF_RECOMMENDED');
      const itags = holder.streamingData.adaptiveFormats.map((x) => x && x.itag).join();
      t(n(`player, ${name}: only the original audio track (by its xtags) is left, video kept`),
        itags === '137,140,251,', itags);
    }
  }
  // ---- Subtitles When a Video Starts: Off, and Translated with a language,
  // drop YouTube's default track ----
  for (const [mode, lang, drops] of [['youtube', 'hu', false], ['off', 'off', true], ['translated', 'hu', true], ['translated', 'off', false]]) {
    const { P } = boot({ subtitlesAtStart: mode, subtitleTranslateLang: lang });
    // streamingData: a player response. Over 1000 bytes: Translated is
    // subtitle-translate.js's, which skips smaller blobs.
    const r = P({ responseContext: { _pad: pad + pad }, streamingData: { adaptiveFormats: [] },
      captions: { playerCaptionsTracklistRenderer: { audioTracks: [{ defaultCaptionTrackIndex: 0, captionsInitialState: 'CAPTIONS_INITIAL_STATE_ON_REQUIRED' }] } } });
    const track = r.captions.playerCaptionsTracklistRenderer.audioTracks[0];
    const kept = track.defaultCaptionTrackIndex === 0 && track.captionsInitialState === 'CAPTIONS_INITIAL_STATE_ON_REQUIRED';
    const dropped = track.defaultCaptionTrackIndex === undefined && track.captionsInitialState === 'CAPTIONS_INITIAL_STATE_OFF_RECOMMENDED';
    t(n(`subtitles at start ${mode}, language ${lang}: YouTube's default track ${drops ? 'dropped' : 'kept'}`),
      drops ? dropped : kept, JSON.stringify(track));
  }
  {
    // No xtags: the track marked default is the original.
    const r = P({ responseContext: { _pad: pad }, streamingData: { adaptiveFormats: [
      { itag: 1, audioTrack: { id: 'a', audioIsDefault: true } },
      { itag: 2, audioTrack: { id: 'b', audioIsDefault: false } }
    ] } });
    t(n('original audio without xtags: the default track kept'),
      r.streamingData.adaptiveFormats.map((x) => x.itag).join() === '1');
    const one = P({ responseContext: { _pad: pad }, streamingData: { adaptiveFormats: [
      { itag: 1, audioTrack: { id: 'a', audioIsDefault: false } },
      { itag: 2, audioTrack: { id: 'a', audioIsDefault: false } }
    ] } });
    t(n('original audio with no track said to be the original: all kept'), one.streamingData.adaptiveFormats.length === 2);
  }

  // ---- The legacy emoji fix on attributed text ----
  {
    const text = (extra) => Object.assign({ content: 'Hi ' + SMILE + ' @user' }, extra);
    const r = P({ responseContext: { _pad: pad }, contents: { sectionListRenderer: { contents: [shelf([tile('emojitile01', {
      header: {
        mention: text({ commandRuns: [{ startIndex: 6, length: 5 }], styleRuns: [{ startIndex: 3, length: 2 }, { length: 2 }, null] }),
        plain: { content: 'Plain ' + SMILE },
        forged: { content: 'a' + OPEN + 'b', commandRuns: [{ startIndex: 2, length: 1 }] },
        section: { sectionString: 'Sec ' + SMILE },
        cleaned: { simpleText: 'no emoji' + OPEN + ' here' },
        runs: { runs: [{ text: 'x' + CLOSE + 'y' }, { text: 'Fun ' + SMILE, bold: true }, null] }
      }
    })])] } } });
    const h = r.contents.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items[0].tileRenderer.header;
    if (modern) {
      t(n('webOS 23: attributed text and its runs are left as they are'), h.mention.content === 'Hi ' + SMILE + ' @user' &&
        h.mention.commandRuns[0].startIndex === 6 && h.plain.content === 'Plain ' + SMILE && h.section.sectionString === 'Sec ' + SMILE);
    } else {
      t(n('attributed text: the emoji wrapped'), h.mention.content === 'Hi ' + OPEN + SMILE + CLOSE + ' @user', JSON.stringify(h.mention.content));
      t(n('...a mention after it moved on by the two marks'), h.mention.commandRuns[0].startIndex === 8 &&
        h.mention.commandRuns[0].length === 5, JSON.stringify(h.mention.commandRuns));
      t(n('...a run on the emoji itself takes in its marks'), h.mention.styleRuns[0].startIndex === 3 &&
        h.mention.styleRuns[0].length === 4, JSON.stringify(h.mention.styleRuns));
      t(n('...a run from the start keeps its start'), h.mention.styleRuns[1].startIndex === undefined &&
        h.mention.styleRuns[1].length === 2, JSON.stringify(h.mention.styleRuns));
      t(n('attributed text without runs: wrapped'), h.plain.content === 'Plain ' + OPEN + SMILE + CLOSE, JSON.stringify(h.plain.content));
      t(n('a forged mark in attributed text: dropped, the run moved back'), h.forged.content === 'ab' &&
        h.forged.commandRuns[0].startIndex === 1, JSON.stringify(h.forged));
      t(n('a section string: wrapped'), h.section.sectionString === 'Sec ' + OPEN + SMILE + CLOSE, JSON.stringify(h.section));
      t(n('a text with a forged mark and no emoji: the mark dropped'), h.cleaned.simpleText === 'no emoji here' &&
        h.runs.runs[0].text === 'xy', JSON.stringify([h.cleaned, h.runs.runs[0]]));
      t(n('a run with an emoji split, keeping its style'), h.runs.runs.length === 4 && h.runs.runs[2].text === OPEN + SMILE + CLOSE &&
        h.runs.runs[2].bold === true && h.runs.runs[3] === null, JSON.stringify(h.runs.runs));
    }
  }

  // ---- A tab placeholder without trackingParams of its own ----
  {
    const r = P({ responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: { tvSecondaryNavRenderer: {
      sections: [{ tvSecondaryNavSectionRenderer: { tabs: [{ tabRenderer: {
        content: {
          tvSurfaceContentRenderer: { continuation: { reloadContinuationData: { continuation: 'c' } } },
          header: { trackingParams: 'tp-header' }
        },
        trackingParams: 'tp-after'
      } }] } }]
    } } } }, trackingParams: 'tp-root' });
    const tab = r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections[0].tvSecondaryNavSectionRenderer.tabs[0].tabRenderer;
    t(n('a placeholder with none of its own: the trackingParams after it are not taken for its, and blanked'),
      tab.content.header.trackingParams === '' && tab.trackingParams === '' && r.trackingParams === '', JSON.stringify(tab));
  }

  // ---- Responses on the Shorts page ----
  {
    env.doc.body.className = 'WEB_PAGE_TYPE_SHORTS';
    await wait(30);
    const player = P({ responseContext: { _pad: pad }, streamingData: {}, adPlacements: [{ a: 1 }],
      videoDetails: { title: 'Short ' + SMILE }, frameworkUpdates: { entityBatchUpdate: { title: { simpleText: 'Fw ' + SMILE } } } });
    t(n('Shorts page: the player response is left unfiltered (its ads stay)'), player.adPlacements.length === 1);
    const fw = player.frameworkUpdates.entityBatchUpdate.title;
    t(n(modern ? 'Shorts page, webOS 23: no emoji wrapped' : 'Shorts page, webOS 3: the emoji are still wrapped'),
      modern ? fw.simpleText === 'Fw ' + SMILE : !!fw.runs && fw.runs[1].text === OPEN + SMILE + CLOSE, JSON.stringify(fw));
    const search = P({ responseContext: { _pad: pad }, contents: { sectionListRenderer: { contents: [shelf([ad(), tile('shortsrch01')])] } } });
    t(n('Shorts page: a search response is left unfiltered'),
      search.contents.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items.length === 2);
    const cont = P({ responseContext: { _pad: pad }, continuationContents: { gridContinuation: { items: [ad(), tile('shortcont01')] } } });
    t(n('Shorts page: a continuation is still filtered'), ids(cont.continuationContents.gridContinuation.items) === 'shortcont01');
    env.doc.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await wait(30);
  }

  // ---- The telemetry block on XMLHttpRequest ----
  {
    const { XHR, xhr } = env;
    const req = (url, body, ...rest) => {
      xhr.length = 0;
      const x = new XHR();
      x.open('POST', url, ...rest);
      x.send(body);
      return xhr.slice();
    };
    let calls = req('https://www.youtube.com/api/stats/qoe?cpn=1', 'secret', false);
    t(n('XHR: a telemetry request goes to an empty data: URL, as asked (sync)'),
      calls[0].join('|') === 'open|GET|data:text/plain,|false', JSON.stringify(calls));
    t(n('...and its body is not sent'), calls[1].length === 1, JSON.stringify(calls));
    calls = req('https://www.youtube.com/youtubei/v1/log_event');
    t(n('XHR: log_event, async by default'), calls[0].join('|') === 'open|GET|data:text/plain,|true', JSON.stringify(calls));
    calls = req('https://www.youtube.com/youtubei/v1/next', 'payload');
    t(n('XHR: any other request goes as asked, with its body'), calls[0].join('|') === 'open|POST|https://www.youtube.com/youtubei/v1/next' &&
      calls[1][1] === 'payload', JSON.stringify(calls));
    calls = req('https://www.youtube.com/youtubei/v1/browse?next=/ptracking', 'b');
    t(n('XHR: a telemetry path in the query only is let through'), calls[0][2] === 'https://www.youtube.com/youtubei/v1/browse?next=/ptracking' &&
      calls[1][1] === 'b', JSON.stringify(calls));
    calls = req(new env.win.URL('https://www.youtube.com/pagead/conversion'), 'b');
    t(n('XHR: a URL object is read too'), calls[0][2] === 'data:text/plain,' && calls[1].length === 1, JSON.stringify(calls));

    const hooked = XHR.prototype.open;
    setSwitch(env.win, 'Reduce Telemetry & Tracking', false);
    calls = req('https://www.youtube.com/api/stats/qoe', 'q');
    t(n('Tracking Block off in the panel: the TV\'s own open() is back, telemetry goes out'),
      XHR.prototype.open !== hooked && calls[0][2] === 'https://www.youtube.com/api/stats/qoe' && calls[1][1] === 'q', JSON.stringify(calls));
    setSwitch(env.win, 'Reduce Telemetry & Tracking', true);
    calls = req('https://www.youtube.com/api/stats/qoe', 'q');
    t(n('...on again: blocked again'), calls[0][2] === 'data:text/plain,', JSON.stringify(calls));
  }

  // ---- Ad Blocking switched off and on ----
  {
    const browse = () => P({ responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: {
      sectionListRenderer: { contents: [shelf([ad(), tile('toggle00001')])] } } } } } } });
    const items = (r) => r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items;
    setSwitch(env.win, 'Ad Blocking', false);
    t(n('Ad Blocking off in the panel: the ads stay'), items(browse()).length === 2);
    const calls = (() => { env.xhr.length = 0; const x = new env.XHR(); x.open('POST', 'https://www.youtube.com/api/stats/qoe'); return env.xhr.slice(); })();
    t(n('...and the Tracking Block, which is part of it, is off too'), calls[0][2] === 'https://www.youtube.com/api/stats/qoe', JSON.stringify(calls));
    setSwitch(env.win, 'Ad Blocking', true);
    t(n('Ad Blocking on again: the ads go'), ids(items(browse())) === 'toggle00001');
  }

  t(n('no page errors'), env.errors.length === 0, env.errors.join(' | '));
});
