// In-page effect tests for YouTube Foxtended, injected by run-app-test.cjs into the
// running YouTube TV page (webOS TV Simulators, Chromium 79+). Settings are
// changed through the settings panel itself, as a user does (the panel must be
// open). window.__ytafFx:
//   set(key, value) -> { ok, now }   through the panel's own control
//   get(key)                          the stored value
//   fp()                              what our code shows: classes, elements, styles
//   cases                             JSON-level cases: run() through YouTube's
//                                     JSON.parse / JSON.stringify, which our hooks wrap
// Payload shapes are the ones bench/feed-features-test.cjs, new-features-test.cjs,
// adblock-test.cjs and search-filter-test.cjs use.
(function () {
  let DESCS = window.__ytafDescs || {};
  let pad = new Array(601).join('z');

  function get(key) {
    let c = {};
    try { c = JSON.parse(localStorage.getItem('ytaf-configuration') || '{}'); } catch (e) { /* none */ }
    return c[key];
  }
  let same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  function visible(el) { let r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }

  // --- the panel ---------------------------------------------------------------
  function tabs() { return document.querySelectorAll('.ytaf-ui-container .ytaf-tab-btn'); }
  function openPage() {
    let pages = document.querySelectorAll('.ytaf-ui-container .ytaf-settings-page');
    for (let i = 0; i < pages.length; i++) if (pages[i].style.display !== 'none') return pages[i];
    return null;
  }
  function textOf(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function findOnPage(page, desc) {
    let labels = page.querySelectorAll('.label-text');
    for (let i = 0; i < labels.length; i++) {
      if (textOf(labels[i]) === desc) {
        let box = labels[i].parentNode.querySelector('input[type=checkbox]');
        if (box) return { type: 'bool', el: box };
      }
    }
    let rows = page.querySelectorAll('.shortcut-control-row');
    for (let j = 0; j < rows.length; j++) {
      let l = rows[j].querySelector('.shortcut-label');
      if (l && textOf(l) === desc) return { type: 'cycle', el: rows[j] };
    }
    let eds = page.querySelectorAll('.ytaf-list-editor');
    for (let k = 0; k < eds.length; k++) {
      let t = eds[k].querySelector('.ytaf-list-title');
      if (t && textOf(t).indexOf(desc) === 0) return { type: 'list', el: eds[k] };
    }
    return null;
  }
  function find(key) {
    let desc = DESCS[key];
    if (!desc) return null;
    let page = openPage();
    let hit = page && findOnPage(page, desc);
    if (hit) return hit;
    let ts = tabs();
    for (let i = 0; i < ts.length; i++) {
      ts[i].click();
      page = openPage();
      hit = page && findOnPage(page, desc);
      if (hit) return hit;
    }
    return null;
  }

  // The app writes the configuration 200 ms after a change (config.js
  // scheduleWrite): read it back only after that.
  let settle = function () { return new Promise(function (r) { setTimeout(r, 300); }); };

  function set(key, value) {
    let c = find(key);
    if (!c) return Promise.resolve({ ok: false, now: get(key), why: 'no control for ' + (DESCS[key] || key) });
    if (c.type === 'cycle') {
      let tries = 0;
      let next = function () {
        if (same(get(key), value) || tries++ >= 45) return Promise.resolve();
        let arrows = c.el.querySelectorAll('.arrow-btn');
        arrows[arrows.length - 1].click();
        return settle().then(next);
      };
      return next().then(function () { return { ok: same(get(key), value), now: get(key), type: 'cycle' }; });
    }
    if (c.type === 'bool') {
      if (!!c.el.checked !== !!value && !c.el.disabled) c.el.click();
    } else if (c.type === 'list') {
      let want = value || [];
      // Remove what is not wanted: each entry is a button that removes itself.
      for (let n = 0; n < 50; n++) {
        let cur = get(key) || [];
        let extra = cur.filter(function (x) { return want.indexOf(x) === -1; })[0];
        if (extra === undefined) break;
        let btns = c.el.querySelectorAll('.ytaf-list-entries .ytaf-list-btn');
        let hit = null;
        // Each entry is a button reading "✕ <value>" (ui.js list editor).
        for (let b = 0; b < btns.length; b++) if (textOf(btns[b]).replace(/^✕\s*/, '') === extra) hit = btns[b];
        if (!hit) break;
        hit.click();
        c = find(key);
      }
      let input = c.el.querySelector('input.ytaf-text-input');
      let add = null;
      let all = c.el.querySelectorAll('button');
      for (let a = 0; a < all.length; a++) if (textOf(all[a]) === 'Add') add = all[a];
      // The Add button's handler focuses the text box again (ui.js), which
      // brings up the simulator's on-screen keyboard and leaves it there:
      // that one focus is skipped here.
      let focus = input.focus;
      input.focus = function () {};
      want.forEach(function (x) {
        if ((get(key) || []).indexOf(x) !== -1) return;
        input.value = x;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        add.click();
      });
      input.focus = focus;
      // The app puts the focus back in the text box after Add, so another
      // entry can follow; that keeps the on-screen keyboard up, which Back
      // closes on a TV. Take the focus away, so it closes here too.
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
    return settle().then(function () {
      return { ok: same(get(key), value) || (c.type === 'bool' && !!get(key) === !!value), now: get(key), type: c.type };
    });
  }

  // --- what our code shows ---------------------------------------------------------
  function fp() {
    let cls = function (el) {
      return Array.prototype.filter.call(el.classList, function (x) { return /ytaf|oled|sb-|sponsor/i.test(x); }).sort();
    };
    let els = {};
    Array.prototype.forEach.call(document.querySelectorAll('[id*=ytaf],[class*=ytaf-],[id*=sponsor],[class*=sb-],[id^=ryd],[class*=ryd]'), function (e) {
      if (e.closest('.ytaf-ui-container') || e.closest('#ytaf-notification-container')) return;
      if (/^STYLE$/.test(e.tagName)) return;
      if (!visible(e)) return;
      let name = e.id || String(e.className).split(' ').filter(function (x) { return /ytaf|sb-|sponsor|ryd/i.test(x); })[0];
      if (name) els[name] = (els[name] || 0) + 1;
    });
    let styles = {};
    Array.prototype.forEach.call(document.querySelectorAll('style'), function (s) {
      if (s.id && /ytaf|oled|sb|sponsor|ryd|emoji|legacy|guide/i.test(s.id)) styles[s.id] = s.textContent.length;
    });
    let v = document.querySelector('video');
    return { html: cls(document.documentElement), body: cls(document.body), els: els, styles: styles, rate: v ? v.playbackRate : null,
      bg: getComputedStyle(document.body).backgroundColor };
  }

  // --- JSON-level cases ----------------------------------------------------------
  function tile(id, o) {
    o = o || {};
    let overlays = [];
    if (o.duration !== null) overlays.push({ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: o.duration || '10:00' } } });
    if (o.watched !== undefined) overlays.push({ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: o.watched } });
    return { tileRenderer: { style: 'TILE_STYLE_YTLR_DEFAULT', contentId: id, onSelectCommand: { watchEndpoint: { videoId: id } },
      header: { tileHeaderRenderer: { thumbnailOverlays: overlays, thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' }] } } },
      metadata: { tileMetadataRenderer: { title: { simpleText: o.title || 'Video ' + id }, lines: [
        { lineRenderer: { items: [{ lineItemRenderer: { text: { runs: [{ text: o.channel || 'Some Channel' }] } } }] } }] } } } };
  }
  function lockup(id, o) {
    o = o || {};
    let duration = o.duration === undefined ? '10:00' : o.duration;
    let badges = duration ? [{ thumbnailBadgeViewModel: { text: duration, badgeStyle: o.live ? 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' : 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } }] : [];
    let bottom = { badges: badges };
    if (o.watched !== undefined) bottom.progressBar = { thumbnailOverlayProgressBarViewModel: { startPercent: o.watched } };
    return { lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      contentImage: { thumbnailViewModel: { image: { sources: [{ url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' }] },
        overlays: [{ thumbnailBottomOverlayViewModel: bottom }] } },
      metadata: { lockupMetadataViewModel: { title: { content: o.title || 'Video ' + id }, metadata: { contentMetadataViewModel: {
        metadataRows: [{ metadataParts: [{ text: { content: o.channel || 'Some Channel' } }] }] } } } },
      rendererContext: { commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: id } } } } } } };
  }
  function browse(items) {
    return { responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: {
      sectionListRenderer: { contents: [{ shelfRenderer: { title: { runs: [{ text: 'Recommended' }] },
        content: { horizontalListRenderer: { items: items } } } }] } } } } } } };
  }
  function idsOf(r) {
    return r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents[0]
      .shelfRenderer.content.horizontalListRenderer.items.map(function (i) { return (i.tileRenderer || i.lockupViewModel).contentId; });
  }
  let through = function (o) { return JSON.parse(JSON.stringify(o)); };
  let has = function (r, id) { return r.ids.indexOf(id) !== -1; };
  let feed = function (items) { return function () { return { ids: idsOf(through(browse(items()))) }; }; };

  let cases = [
    { name: 'Ad Blocking clears the ads from the player data', key: 'enableAdBlock', on: true, off: false, needs: {},
      run: function () {
        let p = through({ responseContext: { visitorData: 'x', _pad: pad }, streamingData: { formats: [{ itag: 18 }] },
          adPlacements: [{ a: 1 }, { b: 2 }], playerAds: [{ c: 3 }], adSlots: [{ d: 4 }], videoDetails: { videoId: 'abc' } });
        return { ads: p.adPlacements ? p.adPlacements.length : 0, playerAds: p.playerAds ? p.playerAds.length : 0, formats: p.streamingData.formats.length };
      },
      expectOn: function (r) { return r.ads === 0 && r.playerAds === 0 && r.formats === 1; },
      expectOff: function (r) { return r.ads === 2 && r.playerAds === 1; } },
    { name: 'Hide Endcards drops the end screen', key: 'hideEndcards', on: true, off: false, needs: { enableAdBlock: true },
      run: function () { let p = through({ responseContext: { _pad: pad }, streamingData: { formats: [] }, endscreen: { endscreenRenderer: {} }, videoDetails: { videoId: 'abc' } }); return { endscreen: !!p.endscreen }; },
      expectOn: function (r) { return !r.endscreen; }, expectOff: function (r) { return r.endscreen; } },
    { name: 'Reduce Tracking blanks trackingParams', key: 'enableTrackingBlock', on: true, off: false, needs: { enableAdBlock: true },
      run: function () { let b = browse([tile('trackme1234')]); b.trackingParams = 'tp-root'; let r = through(b); return { tp: r.trackingParams }; },
      expectOn: function (r) { return r.tp === ''; }, expectOff: function (r) { return r.tp === 'tp-root'; } },
    { name: 'Remove Shorts drops the Shorts tab', key: 'removeGlobalShorts', on: true, off: false, needs: { enableAdBlock: true },
      run: function () {
        let g = through({ responseContext: { _pad: pad }, contents: { tvBrowseRenderer: { content: { tvSecondaryNavRenderer: { sections: [{ tvSecondaryNavSectionRenderer: { tabs: [
          { tabRenderer: { title: 'Home', endpoint: { browseEndpoint: { browseId: 'FEwhat_to_watch' } } } },
          { tabRenderer: { title: 'Shorts', endpoint: { browseEndpoint: { browseId: 'FEshorts' } } } },
          { tabRenderer: { title: 'Subscriptions', endpoint: { browseEndpoint: { browseId: 'FEsubscriptions' } } } }] } }] } } } } });
        return { tabs: g.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections[0].tvSecondaryNavSectionRenderer.tabs.map(function (t) { return t.tabRenderer.title; }) };
      },
      expectOn: function (r) { return r.tabs.join() === 'Home,Subscriptions'; }, expectOff: function (r) { return r.tabs.length === 3; } },
    { name: 'Remove Live Videos drops a live tile', key: 'removeLiveVideos', on: true, off: false, needs: { enableAdBlock: true },
      run: feed(function () { return [lockup('normal12345'), lockup('livelive123', { live: true, duration: 'LIVE' }), lockup('normal67890')]; }),
      expectOn: function (r) { return !has(r, 'livelive123') && has(r, 'normal12345'); }, expectOff: function (r) { return has(r, 'livelive123'); } },
    { name: 'Hide Watched Videos drops a watched tile', key: 'hideWatchedVideos', on: true, off: false, needs: { enableAdBlock: true },
      run: feed(function () { return [tile('watched95__', { watched: 95 }), tile('watched50__', { watched: 50 })]; }),
      expectOn: function (r) { return !has(r, 'watched95__') && has(r, 'watched50__'); }, expectOff: function (r) { return has(r, 'watched95__'); } },
    { name: 'Hide Videos Shorter Than 5 min drops a 3 min video', key: 'minVideoLength', on: '5', off: '0', needs: { enableAdBlock: true },
      run: feed(function () { return [lockup('short310___', { duration: '3:10' }), lockup('long1234___', { duration: '12:34' })]; }),
      expectOn: function (r) { return !has(r, 'short310___') && has(r, 'long1234___'); }, expectOff: function (r) { return has(r, 'short310___'); } },
    { name: 'Blocked Channels drops the channel\'s video', key: 'blockedChannels', on: ['Spam Channel'], off: [], needs: { enableAdBlock: true },
      run: feed(function () { return [lockup('spamchan___', { channel: 'SPAM channel' }), lockup('goodchan___', { channel: 'Good' })]; }),
      expectOn: function (r) { return !has(r, 'spamchan___') && has(r, 'goodchan___'); }, expectOff: function (r) { return has(r, 'spamchan___'); } },
    { name: 'Hide Videos Whose Title Contains drops the title', key: 'blockedKeywords', on: ['clickbait'], off: [], needs: { enableAdBlock: true },
      run: feed(function () { return [tile('keyword____', { title: 'This CLICKBAIT will shock you' }), tile('plain______', { title: 'A calm video' })]; }),
      expectOn: function (r) { return !has(r, 'keyword____') && has(r, 'plain______'); }, expectOff: function (r) { return has(r, 'keyword____'); } },
    { name: 'Search: Upload Date adds the week filter', key: 'searchUploadDate', on: 'week', off: 'any', needs: {},
      run: function () { let b = JSON.parse(JSON.stringify({ context: { client: { clientName: 'TVHTML5' } }, query: 'cats' })); return { params: b.params || null }; },
      expectOn: function (r) { return r.params === 'EgIIAw=='; }, expectOff: function (r) { return r.params === null; } }
  ];

  // One step of a control, as one press: a checkbox flips, a selector moves on.
  // A slider at its end does not move on: then one step back.
  function step(key) {
    let c = find(key);
    if (!c) return Promise.resolve(null);
    if (c.type === 'bool') { if (c.el.disabled) return Promise.resolve('disabled'); c.el.click(); return settle().then(function () { return 'bool'; }); }
    if (c.type === 'cycle') {
      let before = JSON.stringify(get(key));
      let a = c.el.querySelectorAll('.arrow-btn');
      a[a.length - 1].click();
      return settle().then(function () {
        if (JSON.stringify(get(key)) === before) { a[0].click(); return settle().then(function () { return 'cycle-back'; }); }
        return 'cycle';
      });
    }
    return Promise.resolve(c.type);
  }

  // What the watch page's own overlays show (with the player controls up).
  function overlays() {
    let txt = function (id) { let s = document.getElementById(id); return s ? s.textContent : null; };
    // The clock (watch.js) is a div.webOs-watch; the watch time is shown in it.
    let clocks = Array.prototype.filter.call(document.querySelectorAll('.webOs-watch'), function (e) {
      return visible(e) && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
    }).map(function (e) { return (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60); });
    // Whether the player controls are up, as time-remaining.js decides it.
    let bar = document.querySelector('ytlr-progress-bar, ytlr-multi-markers-player-bar-renderer');
    let controls = !!document.querySelector('[idomkey="time-label"]') && (!bar || !(bar.classList.contains('zylon-hidden') || bar.style.opacity === '0'));
    return { timeRemaining: txt('ytaf-time-remaining'), mostReplayed: txt('ytaf-most-replayed'), qualityTag: txt('ytaf-quality-tag'),
      clocks: clocks.join(' | '), ryd: !!document.getElementById('ryd-dislike-factoid'), controls: controls,
      cfg: { timeRemainingMode: get('timeRemainingMode'), showMostReplayed: get('showMostReplayed'), clockMode: get('clockMode'), showWatchTime: get('showWatchTime'), showQualityInTitle: get('showQualityInTitle') } };
  }
  // The player controls up, as a key press does on the TV (in-page event, as
  // the app's own sendKey).
  function wake() {
    ['keydown', 'keyup'].forEach(function (t) {
      let e = new KeyboardEvent(t, { bubbles: true, cancelable: true, key: 'ArrowUp', code: 'ArrowUp' });
      Object.defineProperty(e, 'keyCode', { get: function () { return 38; } });
      Object.defineProperty(e, 'which', { get: function () { return 38; } });
      document.body.dispatchEvent(e);
    });
    return true;
  }

  // --- YouTube's real responses, replayed -------------------------------------------
  // run-app-test.cjs's counter keeps the raw text of the real responses this run
  // received (window.__ytafReal.texts). replay() sends them through JSON.parse
  // again, so through our hook with the settings as they are now, and sums up
  // what is left: the same real data, with a setting off and then on.
  function secs(t) {
    if (!t || !/^\d+(?::\d+){1,2}$/.test(t)) return null;
    return t.split(':').reduce(function (a, x) { return a * 60 + (+x); }, 0);
  }
  function itemOf(kind, r) {
    let s = JSON.stringify(r);
    let title = '', channel = '', duration = null, pct = null;
    if (kind === 'tile') {
      let md = r.metadata && r.metadata.tileMetadataRenderer;
      title = md && md.title ? (md.title.simpleText || (md.title.runs || []).map(function (x) { return x.text; }).join('')) : '';
      try { channel = md.lines[0].lineRenderer.items[0].lineItemRenderer.text.runs[0].text; } catch (e) { /* none */ }
      let ov = (r.header && r.header.tileHeaderRenderer && r.header.tileHeaderRenderer.thumbnailOverlays) || [];
      ov.forEach(function (o) {
        if (o.thumbnailOverlayTimeStatusRenderer && o.thumbnailOverlayTimeStatusRenderer.text) duration = secs(o.thumbnailOverlayTimeStatusRenderer.text.simpleText);
        if (o.thumbnailOverlayResumePlaybackRenderer) pct = o.thumbnailOverlayResumePlaybackRenderer.percentDurationWatched;
      });
    } else {
      try { title = r.metadata.lockupMetadataViewModel.title.content; } catch (e) { /* none */ }
      try { channel = r.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows[0].metadataParts[0].text.content; } catch (e) { /* none */ }
      try {
        r.contentImage.thumbnailViewModel.overlays.forEach(function (o) {
          let b = o.thumbnailBottomOverlayViewModel;
          if (!b) return;
          (b.badges || []).forEach(function (x) { if (x.thumbnailBadgeViewModel && secs(x.thumbnailBadgeViewModel.text) !== null) duration = secs(x.thumbnailBadgeViewModel.text); });
          if (b.progressBar && b.progressBar.thumbnailOverlayProgressBarViewModel) pct = b.progressBar.thumbnailOverlayProgressBarViewModel.startPercent;
        });
      } catch (e) { /* none */ }
    }
    return { id: r.contentId || (r.videoId) || '', kind: kind, title: title || '', channel: channel || '', duration: duration, pct: pct,
      live: /BADGE_STYLE_LIVE|"style":"LIVE"|TILE_CONTENT_TYPE_LIVE/.test(s), upcoming: /UPCOMING/.test(s),
      members: /MEMBERS_ONLY|BADGE_STYLE_MEMBERS|"Members only"|Csak tagoknak/i.test(s),
      shorts: kind === 'reel' || /SHORTS|reelWatchEndpoint/.test(s) };
  }
  function walk(o, out, depth) {
    if (!o || typeof o !== 'object' || depth > 60) return;
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) walk(o[i], out, depth + 1); return; }
    if (o.tileRenderer) out.push(itemOf('tile', o.tileRenderer));
    else if (o.lockupViewModel) out.push(itemOf('lockup', o.lockupViewModel));
    else if (o.reelItemRenderer || o.shortsLockupViewModel) out.push(itemOf('reel', o.reelItemRenderer || o.shortsLockupViewModel));
    for (let k in o) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] && typeof o[k] === 'object') walk(o[k], out, depth + 1);
  }
  function replay() {
    let R = window.__ytafReal;
    let texts = (R && R.texts) || [];
    let stringify = window.__ytafNativeStringify || JSON.stringify;
    let sum = { responses: texts.length, items: 0, live: 0, upcoming: 0, members: 0, shorts: 0, watched: 0, under5min: 0,
      ads: 0, tracking: 0, endscreen: 0, shortsShelves: 0, ai: 0, channels: {}, words: {} };
    // The videos the AI check learned (ai-video-store.js), to see them go.
    let aiIds = {};
    // ai-video-store.js keeps [{ id, expiresAt }].
    try { (JSON.parse(localStorage.getItem('ytaf-ai-videos') || '[]') || []).forEach(function (e) { if (e && e.id) aiIds[e.id] = 1; }); } catch (e) { /* none */ }
    window.__ytafReplaying = 1;
    try {
      texts.forEach(function (t) {
        let o;
        try { o = JSON.parse(t); } catch (e) { return; }
        let after = stringify(o) || '';
        sum.ads += (after.match(/"(adPlacements|adSlots|playerAds)":\[\{|"adSlotRenderer"|"promotedSparklesWebRenderer"/g) || []).length;
        sum.tracking += (after.match(/"trackingParams":"[^"]+"/g) || []).length;
        sum.endscreen += (after.match(/"endscreenRenderer"/g) || []).length;
        sum.shortsShelves += (after.match(/"reelShelfRenderer"|"title":\{"runs":\[\{"text":"Shorts"/g) || []).length;
        let items = [];
        walk(o, items, 0);
        // Which response this is: its browse_id, or its top-level keys.
        let where = '';
        try { (o.responseContext.serviceTrackingParams || []).forEach(function (p) { (p.params || []).forEach(function (q) { if (q.key === 'browse_id') where = q.value; }); }); } catch (e) { /* none */ }
        if (!where) where = Object.keys(o).filter(function (k) { return k !== 'responseContext' && k !== 'trackingParams'; }).slice(0, 2).join('+');
        sum.samples = sum.samples || { watched: [], under5min: [] };
        items.forEach(function (it) {
          sum.items++;
          if (it.id && aiIds[it.id]) { sum.ai++; sum.samples = sum.samples || { watched: [], under5min: [] }; (sum.samples.ai = sum.samples.ai || []).push(where + ' | ' + it.kind + ' | ' + it.id + ' | ' + it.title.slice(0, 40)); }
          if (it.live) sum.live++;
          if (it.upcoming) sum.upcoming++;
          if (it.members) sum.members++;
          if (it.shorts) sum.shorts++;
          if (it.pct !== null && it.pct >= 90) { sum.watched++; if (sum.samples.watched.length < 12) sum.samples.watched.push(where + ' | ' + it.kind + ' | ' + it.pct + '% | ' + it.title.slice(0, 40)); }
          if (it.duration !== null && it.duration < 300) { sum.under5min++; if (sum.samples.under5min.length < 12) sum.samples.under5min.push(where + ' | ' + it.kind + ' | ' + it.duration + 's | ' + it.title.slice(0, 40)); }
          if (it.channel) sum.channels[it.channel] = (sum.channels[it.channel] || 0) + 1;
          (it.title.toLowerCase().match(/[a-záéíóöőúüű]{6,}/g) || []).forEach(function (w) { sum.words[w] = (sum.words[w] || 0) + 1; });
        });
      });
    } finally { window.__ytafReplaying = 0; }
    return sum;
  }
  // The real data's most frequent channel and title word, to block.
  function top(map) { let best = null; for (let k in map) if (!best || map[k] > map[best]) best = k; return best; }

  window.__ytafFx = { set: set, get: get, fp: fp, cases: cases, step: step, overlays: overlays, wake: wake, replay: replay, top: top,
    find: function (k) { let c = find(k); return c ? c.type : null; } };
})();
