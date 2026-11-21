/**
 * SponsorBlock on the seek bar, in the bundle: the segment marks drawn beside
 * YouTube's progress bar (colours, positions, the highlight, what is left
 * off), the segment list in the settings panel, the full-video badge and the
 * time with skips removed, settings changed in the panel mid-video, and the
 * bar or the overlay rebuilt by YouTube (a late bar, a replaced one, a replay).
 * sponsorblock-skip-test covers the skip itself; nothing ran this part of
 * sponsorblock.js, Sponsorblock-UI.js or sponsorblock-labels.js in the bundle.
 *
 *   node bench/sponsorblock-bar-test.cjs <bundle> [legacy|modern]
 *
 * The <video> is a stand-in whose time and duration the test sets, as in
 * sponsorblock-skip-test; the API is faked; settings are changed through the
 * panel's own controls.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();

const VIDEO_ID = 'abcdefghijk';

const { t, run } = createReporter();

const seg = (category, start, end, actionType = 'skip') =>
  ({ UUID: `${category}-${start}-${actionType}`, category, actionType, segment: [start, end] });

// '#00d400' -> 'rgb(0, 212, 0)', as the element's style reads it back.
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const near = (a, b) => Math.abs(a - b) < 0.01;

// The seek bar as the TV UI renders it: the multi-markers renderer around
// ytlr-progress-bar around the track. The overlay belongs beside the renderer.
const BAR_MULTI = '<div class="bar-host"><ytlr-multi-markers-player-bar-renderer><ytlr-progress-bar>' +
  '<div idomkey="progress-bar"></div></ytlr-progress-bar></ytlr-multi-markers-player-bar-renderer></div>';
// The older layout: ytlr-progress-bar with its slider, no renderer around it.
const BAR_OLD = '<div class="bar-host"><ytlr-progress-bar><div idomkey="slider"></div></ytlr-progress-bar></div>';

// A <video> whose time, play state and duration the test sets.
function fakeVideo(win, video, duration) {
  const state = { time: 0, paused: false, muted: false, seeks: [], duration };
  const fire = (type) => video.dispatchEvent(new win.Event(type));
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => state.time,
      set: (v) => {
        state.time = v;
        state.seeks.push(v);
        fire('seeking');
        setTimeout(() => fire('seeked'), 5);
      }
    },
    duration: { configurable: true, get: () => state.duration },
    paused: { configurable: true, get: () => state.paused },
    seeking: { configurable: true, get: () => false },
    readyState: { configurable: true, get: () => 4 },
    muted: { configurable: true, get: () => state.muted, set: (v) => { state.muted = !!v; } },
    play: { configurable: true, value: () => { state.paused = false; fire('playing'); return Promise.resolve(); } },
    pause: { configurable: true, value: () => { state.paused = true; fire('pause'); } }
  });
  const playTo = async (time) => {
    state.time = time;
    fire('timeupdate');
    await wait(40);   // the rAF loop, the toast, a seek's 'seeked'
  };
  const setDuration = async (d) => {
    state.duration = d;
    fire('durationchange');
    await wait(20);
  };
  return { state, playTo, setDuration };
}

/**
 * The bundle on a watch page whose API answers `segments`. opts.bar: the bar
 * markup in the player (BAR_MULTI by default, '' for none yet).
 */
async function boot(cfg, segments, opts = {}) {
  const bar = opts.bar === undefined ? BAR_MULTI : opts.bar;
  const { win, doc, errors, evaluate } = bootPage({
    code,
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    inner: `\n    <div id="ytlr-player__player-container-player"><video></video></div>${bar}`,
    url: `https://www.youtube.com/tv#/watch?v=${VIDEO_ID}`,
    ignoreNavigation: true,
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: true, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, sbPeriodicRefresh: false
    }, cfg),
    evaluate: false
  });
  // The bar poll (every 250 ms, ~10 s in all) ten times as fast, so a test
  // can outlast it.
  // `polls` holds the bar polls still running.
  const polls = new Set();
  if (opts.fastPoll) {
    const realInterval = win.setInterval.bind(win);
    const realClear = win.clearInterval.bind(win);
    win.setInterval = (fn, ms, ...args) => {
      const id = realInterval(fn, ms === 250 ? 25 : ms, ...args);
      if (ms === 250) polls.add(id);
      return id;
    };
    win.clearInterval = (id) => { polls.delete(id); return realClear(id); };
  }
  const net = { segments, asked: [] };
  win.fetch = (resource) => {
    const url = String(resource && resource.url || resource);
    if (url.indexOf('/skipSegments/') === -1) return new Promise(() => {});
    net.asked.push(url);
    const body = [{ videoID: VIDEO_ID, segments: JSON.parse(JSON.stringify(net.segments)) }];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  // opts.author: the channel the player names for the video.
  if ('author' in opts) {
    win.document.getElementById('ytlr-player__player-container-player').getVideoData = () => ({ video_id: VIDEO_ID, author: opts.author });
  }
  const video = win.document.querySelector('video');
  const v = fakeVideo(win, video, opts.duration || 600);
  evaluate();
  for (let i = 0; i < 100 && !net.asked.length; i++) await wait(50);
  await wait(150);
  const toasts = () => (doc.querySelector('.ytaf-notification-container') || {}).textContent || '';
  const overlay = () => doc.getElementById('previewbar');
  const marks = () => {
    const o = overlay();
    return o ? Array.prototype.slice.call(o.querySelectorAll('.previewbar')) : [];
  };
  const rows = () => Array.prototype.map.call(doc.querySelectorAll('.sb-segments-popup .sb-segment-row'), (r) => ({
    name: r.querySelector('.sb-segment-category').textContent,
    time: r.querySelector('.sb-segment-time').textContent,
    color: r.querySelector('.sb-segment-dot').style.backgroundColor
  }));
  const popupShown = () => {
    const p = doc.querySelector('.sb-segments-popup');
    return !!p && p.classList.contains('visible');
  };
  const labelsCss = () => (doc.getElementById('sb-labels') || {}).textContent || '';
  const playerState = (s) => { win.dispatchEvent(new win.CustomEvent('yt-player-state-change', { detail: { state: s } })); };

  // The panel, on its SponsorBlock tab.
  // The panel ignores a toggle in its first 500 ms.
  let openedAt = 0;
  const openPanel = async () => {
    win.ytaf_showOptionsPanel(true);
    if (!openedAt) openedAt = Date.now();
    await wait(30);
    doc.querySelectorAll('.ytaf-tab-btn')[3].click();
    await wait(30);
  };
  const closePanel = async () => {
    await wait(Math.max(0, openedAt + 600 - Date.now()));
    win.ytaf_showOptionsPanel(false);
    await wait(30);
  };
  const row = (text) => {
    const all = doc.querySelectorAll('.ytaf-ui-container .shortcut-control-row');
    for (let i = 0; i < all.length; i++) {
      if ((all[i].querySelector('.shortcut-label') || {}).textContent === text) return all[i];
    }
    throw new Error('no control "' + text + '" in the panel');
  };
  /** One step of a cycle control: the row clicked (next), or its '<' (back). */
  const cycle = async (text, back = false) => {
    const r = row(text);
    (back ? r.querySelector('.arrow-btn') : r).click();
    await wait(30);
    return r.querySelector('.current-value').textContent;
  };
  const pickColor = async (text, hex) => {
    const input = row(text).querySelector('input[type="color"]');
    input.value = hex;
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await wait(30);
  };
  const toggle = async (text) => {
    const labels = doc.querySelectorAll('.ytaf-ui-container label');
    for (let i = 0; i < labels.length; i++) {
      const span = labels[i].querySelector('.label-text');
      if (span && span.textContent === text) {
        const input = labels[i].querySelector('input');
        input.checked = !input.checked;
        input.dispatchEvent(new win.Event('change', { bubbles: true }));
        await wait(30);
        return input.checked;
      }
    }
    throw new Error('no switch "' + text + '" in the panel');
  };
  return { win, doc, errors, net, video, ...v, toasts, overlay, marks, rows, popupShown, labelsCss, playerState,
    openPanel, closePanel, cycle, pickColor, toggle, polls: () => polls.size, sb: () => win.sponsorblock };
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- The marks on the bar ----
  {
    const env = await boot({ selfpromoColor: '#123456', sbMode_intro: 'disable' }, [
      seg('sponsor', 30, 60),
      seg('selfpromo', 120, 150),
      seg('intro', 200, 210),            // its category switched off
      seg('preview', 300, 320),          // Show in Seek Bar (the default)
      seg('poi_highlight', 400, 400, 'poi'),
      seg('sponsor', 0, 0, 'full'),      // a full-video label
      seg('sponsor', 500, 510, 'mute')   // muting is off
    ]);
    const o = env.overlay();
    const host = env.doc.querySelector('.bar-host');
    const renderer = env.doc.querySelector('ytlr-multi-markers-player-bar-renderer');
    t(n('the overlay is drawn beside the bar renderer, not inside it'),
      !!o && o.parentNode === host && o.previousSibling === renderer && !renderer.contains(o),
      o ? o.parentNode.className + ' / ' + (o.previousSibling && o.previousSibling.nodeName) : 'no overlay');
    const m = env.marks();
    t(n('one mark per segment shown: sponsor, self-promo, preview, highlight'), m.length === 4, String(m.length));
    const [sponsor, selfpromo, preview, highlight] = m;
    t(n('the sponsor mark: 0:30-1:00 of 10:00 is 5% in, 5% wide'),
      !!sponsor && near(parseFloat(sponsor.style.left), 5) && near(parseFloat(sponsor.style.width), 5),
      sponsor && sponsor.style.cssText);
    t(n('...in the sponsor colour'), !!sponsor && sponsor.style.backgroundColor === rgb('#00d400'),
      sponsor && sponsor.style.backgroundColor);
    t(n('the self-promo mark in the colour set for it'), !!selfpromo && selfpromo.style.backgroundColor === rgb('#123456') &&
      near(parseFloat(selfpromo.style.left), 20), selfpromo && selfpromo.style.cssText);
    t(n('a Show in Seek Bar segment has its mark too'), !!preview && preview.style.backgroundColor === rgb('#008fd6') &&
      near(parseFloat(preview.style.left), 50), preview && preview.style.cssText);
    t(n('the highlight: a point mark above the others'), !!highlight && highlight.classList.contains('highlight') &&
      near(parseFloat(highlight.style.left), 400 / 6) && highlight.style.width === '' &&
      highlight.style.zIndex === '2001' && highlight.style.backgroundColor === rgb('#ff1684'),
      highlight && highlight.style.cssText);
    t(n('segment marks are see-through, the highlight is not'), !!sponsor && sponsor.style.opacity === '0.7' &&
      sponsor.style.zIndex === '2000' && !!highlight && highlight.style.opacity === '');
    t(n('marks: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }


  // ---- The overlay follows the bar's track ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)]);
    const host = env.doc.querySelector('.bar-host');
    const renderer = env.doc.querySelector('ytlr-multi-markers-player-bar-renderer');
    const track = env.doc.querySelector('[idomkey="progress-bar"]');
    t(n('the bar\'s box becomes the overlay\'s positioning context'), host.style.position === 'relative', host.style.cssText);
    const rect = (top, left) => () => ({ top, left, right: left, bottom: top, width: 0, height: 0 });
    host.getBoundingClientRect = rect(600, 40);
    track.getBoundingClientRect = rect(612, 70);
    Object.defineProperty(track, 'offsetWidth', { configurable: true, get: () => 1200 });
    Object.defineProperty(track, 'offsetHeight', { configurable: true, get: () => 8 });
    env.win.dispatchEvent(new env.win.Event('resize'));
    await wait(20);
    const st = env.overlay().style;
    t(n('the overlay covers the track exactly: 12px down, 30px in, 1200x8'),
      st.top === '12px' && st.left === '30px' && st.width === '1200px' && st.height === '8px' && st.opacity === '1',
      st.cssText);
    renderer.classList.add('zylon-hidden');
    env.win.dispatchEvent(new env.win.Event('resize'));
    await wait(20);
    t(n('the bar hidden with the player controls: the overlay too'), env.overlay().style.opacity === '0',
      env.overlay().style.cssText);
    renderer.classList.remove('zylon-hidden');
    track.getBoundingClientRect = rect(650, 70);
    env.win.dispatchEvent(new env.win.Event('resize'));
    await wait(20);
    t(n('...shown again, and moved with the bar'), env.overlay().style.opacity === '1' &&
      env.overlay().style.top === '50px', env.overlay().style.cssText);
  }

  // ---- The time label after the bar ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)], {
      bar: BAR_MULTI.replace(/<\/div>$/, '<div idomkey="time-label"><span idomkey="duration">10:00</span></div></div>')
    });
    const o = env.overlay();
    const label = env.doc.querySelector('[idomkey="time-label"]');
    t(n('with the time label after the bar: the overlay goes between them'), !!o &&
      o.previousSibling === env.doc.querySelector('ytlr-multi-markers-player-bar-renderer') && o.nextSibling === label);
  }

  // ---- The older bar layout ----
  {
    const env = await boot({}, [seg('sponsor', 60, 120)], { bar: BAR_OLD });
    const pb = env.doc.querySelector('ytlr-progress-bar');
    const o = env.overlay();
    t(n('older layout: the overlay beside ytlr-progress-bar'), !!o && o.previousSibling === pb &&
      env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), 10), o ? o.outerHTML.slice(0, 120) : 'none');
  }

  // ---- The segment list in the panel ----
  {
    const env = await boot({ sbMode_intro: 'disable', sbMode_highlight: 'ask' }, [
      seg('selfpromo', 3725, 3760),
      seg('sponsor', 30, 60),
      seg('intro', 200, 210),
      seg('poi_highlight', 400, 400, 'poi'),
      seg('sponsor', 0, 0, 'full'),
      seg('sponsor', 500, 510, 'mute')
    ], { duration: 4000 });
    t(n('the list is not shown with the panel closed'), !env.popupShown());
    await env.openPanel();
    t(n('the SponsorBlock tab on a watch page shows the list'), env.popupShown());
    const titles = Array.prototype.filter.call(env.doc.querySelectorAll('.ytaf-ui-container div'),
      (el) => el.childElementCount === 0 && el.textContent.trim() === 'Never Skip on These Channels');
    t(n('the SponsorBlock tab names Never Skip on These Channels once'), titles.length === 1, String(titles.length));
    const r = env.rows();
    t(n('one row per segment, in time order, no full-video label, no mute segment while muting is off'),
      r.map((x) => x.name).join() === 'Sponsor,Intermission/Intro,Highlight,Unpaid/Self Promotion', JSON.stringify(r));
    t(n('a row gives the segment\'s times'), r[0] && r[0].time === '00:30 to 01:00', r[0] && r[0].time);
    t(n('...past an hour with the hours'), r[3] && r[3].time === '01:02:05 to 01:02:40', r[3] && r[3].time);
    t(n('...the highlight a single time'), r[2] && r[2].time === '06:40', r[2] && r[2].time);
    t(n('...and a dot in the category\'s colour'), r[0] && r[0].color === rgb('#00d400') &&
      r[3] && r[3].color === rgb('#ffff00'), JSON.stringify(r.map((x) => x.color)));
    await env.toggle('Allow segments that mute audio');
    t(n('muting switched on: the mute segment is listed'), env.rows().length === 5 &&
      env.rows()[3].name === 'Sponsor' && env.rows()[3].time === '08:20 to 08:30', JSON.stringify(env.rows()));
    await env.pickColor('Sponsor', '#ff0000');
    t(n('a colour picked in the panel: the list\'s dots follow'), env.rows()[0].color === rgb('#ff0000'), env.rows()[0].color);
    env.doc.querySelectorAll('.ytaf-tab-btn')[0].click();
    await wait(30);
    t(n('another tab: the list goes'), !env.popupShown());
    env.doc.querySelectorAll('.ytaf-tab-btn')[3].click();
    await wait(30);
    await env.closePanel();
    t(n('the panel closed: the list goes'), !env.popupShown());
    t(n('list: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }

  // ---- The full-video badge and the time with skips removed ----
  {
    const env = await boot({ sbFullVideoLabel: true, sbShowTimeWithSkips: true, sbMode_intro: 'disable' }, [
      seg('selfpromo', 0, 0, 'full'),
      seg('sponsor', 30, 60),
      seg('selfpromo', 50, 90),          // overlaps the sponsor read
      seg('preview', 300, 320),          // Show in Seek Bar counts too
      seg('intro', 400, 460)             // switched off: plays
    ]);
    const css = env.labelsCss();
    t(n('a self-promo video: the badge before the title says so'), /title-text"\]::before\{content:"Self Promo";background-color:#ffff00;color:#000;\}/.test(css), css);
    t(n('the duration gets the time with skips removed, overlaps counted once'),
      /\[idomkey="duration"\]::after\{content:"\(8:40\)";\}/.test(css), css);
    t(n('the full-video label has no mark on the bar'), env.marks().length === 3, String(env.marks().length));
    await env.openPanel();
    await env.toggle('Show an icon when a video is entirely an advertisement');
    t(n('the badge switched off in the panel: gone at once'), !/::before/.test(env.labelsCss()) &&
      /\(8:40\)/.test(env.labelsCss()), env.labelsCss());
    await env.cycle('Preview/Recap', true);   // Show in Seek Bar -> Manual Skip
    t(n('...the time follows a category\'s setting'), /\(8:40\)/.test(env.labelsCss()), env.labelsCss());
    await env.cycle('Preview/Recap', true);   // Manual Skip -> Auto Skip
    await env.cycle('Preview/Recap', true);   // Auto Skip -> Disable
    t(n('...a category switched off plays, and is not taken off'), /\(9:00\)/.test(env.labelsCss()), env.labelsCss());
  }
  {
    // Ignore Segments Shorter Than 5 s: the 3 s one plays, only the 20 s one comes off.
    const env = await boot({ sbShowTimeWithSkips: true, sbMinSegmentLength: '5' }, [seg('sponsor', 30, 33), seg('selfpromo', 100, 120)]);
    t(n('the time with skips removed leaves in a segment too short to skip'), /\(9:40\)/.test(env.labelsCss()), env.labelsCss());
    t(n('...and that segment keeps its mark on the bar'), env.marks().length === 2, String(env.marks().length));
  }
  {
    // Never Skip on These Channels: nothing is skipped, so no time comes off.
    const listed = await boot({ sbShowTimeWithSkips: true, sbWhitelistChannels: ['listed channel'] },
      [seg('sponsor', 30, 60)], { author: 'Listed Channel' });
    const other = await boot({ sbShowTimeWithSkips: true, sbWhitelistChannels: ['Other Channel'] },
      [seg('sponsor', 30, 60)], { author: 'Listed Channel' });
    t(n('the time with skips removed: control: a channel not on the list gets it'), /\(9:30\)/.test(other.labelsCss()), other.labelsCss());
    t(n('the time with skips removed: a channel on Never Skip gets none'), !/\(\d+:\d\d\)/.test(listed.labelsCss()), listed.labelsCss());
  }
  {
    const env = await boot({ sbFullVideoLabel: true }, [seg('sponsor', 0, 0, 'full')]);
    t(n('only a full-video label: no overlay on the bar'), env.overlay() === null &&
      env.doc.querySelector('.bar-host').children.length === 1);
    t(n('...the badge is shown'), /content:"Sponsor"/.test(env.labelsCss()), env.labelsCss());
    await env.openPanel();
    t(n('...and no list (nothing in it)'), !env.popupShown() && env.rows().length === 0);
  }

  // ---- Settings changed mid-video ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60), seg('selfpromo', 120, 150), seg('poi_highlight', 400, 400, 'poi')]);
    const lefts = () => env.marks().map((m) => Math.round(parseFloat(m.style.left))).join();
    t(n('mid-video: three marks to start with'), lefts() === '5,20,67', lefts());
    await env.openPanel();
    t(n('Sponsor set to Disable in the panel'), await env.cycle('Sponsor', true) === 'Disable');
    t(n('...its mark goes at once'), lefts() === '20,67', lefts());
    await env.playTo(10);
    await env.playTo(30.2);
    t(n('...and it is no longer skipped'), env.state.time === 30.2 && env.state.seeks.length === 0, env.state.seeks.join(','));
    t(n('Sponsor back to Auto Skip'), await env.cycle('Sponsor') === 'Auto Skip');
    t(n('...its mark is back'), lefts() === '5,20,67', lefts());
    await env.playTo(20);
    await env.playTo(30.5);
    t(n('...and it is skipped again'), env.state.time === 60, env.state.seeks.join(','));
    t(n('Sponsor set to Manual Skip'), await env.cycle('Sponsor') === 'Manual Skip');
    env.video.currentTime = 20;
    await wait(40);
    await env.playTo(30.5);
    t(n('...the segment is offered, not skipped'), env.state.time === 30.5 && /Sponsored: Press Blue to skip/.test(env.toasts()),
      env.toasts());
    const before = env.overlay();
    await env.pickColor('Self Promotion', '#abcdef');
    const sp = env.marks()[1];
    t(n('a colour picked in the panel: the mark is redrawn in it'), !!sp && sp.style.backgroundColor === rgb('#abcdef') &&
      env.overlay() !== before, sp && sp.style.backgroundColor);
    t(n('Highlight set to Disable'), await env.cycle('Highlight') === 'Disable');
    t(n('...the highlight mark goes'), lefts() === '5,20' && !env.doc.querySelector('.previewbar.highlight'), lefts());
    t(n('settings mid-video: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }
  {
    const env = await boot({}, [seg('sponsor', 30, 60), seg('sponsor', 200, 260, 'mute')]);
    t(n('a mute segment has no mark while muting is off'), env.marks().length === 1);
    await env.openPanel();
    await env.toggle('Allow segments that mute audio');
    const m = env.marks();
    t(n('muting switched on: its mark appears'), m.length === 2 && near(parseFloat(m[1].style.left), 200 / 6) &&
      near(parseFloat(m[1].style.width), 10), m.map((x) => x.style.cssText).join(' | '));
    await env.playTo(100);
    await env.playTo(210);
    t(n('...and it mutes'), env.state.muted === true && env.state.time === 210);
    await env.cycle('Sponsor', true);   // Auto Skip -> Disable
    t(n('every segment\'s category switched off: the bar is left clean'), env.overlay() === null &&
      env.doc.querySelector('.bar-host').children.length === 1);
  }

  // ---- The duration: early and short, then the real one ----
  {
    const env = await boot({}, [seg('sponsor', 50, 150)], { duration: 100 });
    const m0 = env.marks()[0];
    // On webOS 3 an end at the very end is pulled 0.3 s in (the TV's seek to
    // the end never fires 'ended').
    const cut = modern ? 50 : 49.7;
    t(n('a segment past the end is drawn up to the end'), !!m0 && near(parseFloat(m0.style.left), 50) &&
      near(parseFloat(m0.style.width), cut), m0 && m0.style.cssText);
    await env.setDuration(600);
    const m1 = env.marks()[0];
    t(n('the real duration: the mark is redrawn to the segment\'s own end'), !!m1 &&
      near(parseFloat(m1.style.left), 50 / 6) && near(parseFloat(m1.style.width), 100 / 6), m1 && m1.style.cssText);
    await env.playTo(40);
    await env.playTo(50.2);
    t(n('...and the skip goes to that end, not the early one'), env.state.time === 150, env.state.seeks.join(','));
  }

  // ---- The bar rebuilt by YouTube ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60), seg('intro', 300, 330)]);
    const host = env.doc.querySelector('.bar-host');
    const first = env.overlay();
    // The host re-rendered: the renderer and the overlay beside it replaced.
    host.innerHTML = BAR_MULTI.replace(/^<div class="bar-host">|<\/div>$/g, '');
    await wait(100);
    const renderer = env.doc.querySelector('ytlr-multi-markers-player-bar-renderer');
    const o = env.overlay();
    t(n('the bar re-rendered: the overlay is drawn again beside the new one'), !!o && o !== first &&
      o.previousSibling === renderer && env.marks().length === 2, o ? 'prev ' + (o.previousSibling && o.previousSibling.nodeName) : 'none');
    o.parentNode.removeChild(o);
    await wait(100);
    t(n('the overlay alone removed: put back'), !!env.overlay() && env.overlay().parentNode === host &&
      env.doc.querySelectorAll('#previewbar').length === 1 && env.marks().length === 2);
    t(n('re-render: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }
  {
    const env = await boot({}, [seg('sponsor', 30, 60)], { bar: '' });
    t(n('no bar yet: nothing drawn'), env.overlay() === null);
    env.doc.querySelector('ytlr-app').insertAdjacentHTML('beforeend', BAR_MULTI);
    await wait(100);
    t(n('the bar mounting later: the overlay is drawn on it'), !!env.overlay() && env.marks().length === 1 &&
      env.overlay().previousSibling === env.doc.querySelector('ytlr-multi-markers-player-bar-renderer'));
  }
  {
    const env = await boot({}, [seg('sponsor', 30, 60)], { bar: '', fastPoll: true });
    await wait(100);
    // Outside ytlr-app, where the observer waiting for the bar does not look:
    // only the poll finds it.
    env.doc.body.insertAdjacentHTML('beforeend', BAR_OLD);
    await wait(300);
    t(n('a bar the observer cannot see: the poll still finds it'), !!env.overlay() && env.marks().length === 1);
  }

  // ---- Replay: the player chrome torn down at the end, rebuilt later ----
  {
    const env = await boot({}, [seg('sponsor', 30, 60)], { fastPoll: true });
    t(n('replay: drawn before the end'), !!env.overlay());
    env.playerState(0);   // ENDED
    env.doc.querySelector('.bar-host').remove();
    await wait(50);
    env.playerState(1);   // PLAYING again
    // Past the poll's tries: only an observer re-armed on PLAYING sees the new bar.
    const pollEnd = Date.now() + 5000;
    while (env.polls() > 0 && Date.now() < pollEnd) await wait(25);
    t(n('...the bar poll has run out'), env.polls() === 0, `${env.polls()} still running`);
    t(n('...nothing drawn while the bar is gone'), env.overlay() === null);
    env.doc.querySelector('ytlr-app').insertAdjacentHTML('beforeend', BAR_MULTI);
    await wait(100);
    t(n('...the rebuilt bar gets its marks again'), !!env.overlay() && env.marks().length === 1 &&
      env.overlay().parentNode === env.doc.querySelector('.bar-host'));
    t(n('replay: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }
});
