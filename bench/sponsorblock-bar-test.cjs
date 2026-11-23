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
const { createReporter, flavorFromArgs, wait } = require('./harness.cjs');
const { BAR_MULTI, BAR_OLD, seg, bootSponsorBlock } = require('./sponsorblock-fixtures.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();

const { t, run } = createReporter();

// '#00d400' -> 'rgb(0, 212, 0)', as the element's style reads it back.
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const near = (a, b) => Math.abs(a - b) < 0.01;

/**
 * The bundle on a watch page whose API answers `segments`
 * (sponsorblock-fixtures.cjs). opts.bar: the bar markup in the player
 * (BAR_MULTI by default, '' for none yet); opts.fastPoll: the bar poll (every
 * 250 ms, ~10 s in all) ten times as fast, so a test can outlast it.
 */
async function boot(cfg, segments, opts = {}) {
  // `polls` holds the bar polls still running.
  const polls = new Set();
  const measure = { fn: null, id: -7 };
  const env = await bootSponsorBlock(cfg, segments, Object.assign({}, opts, {
    bar: opts.bar === undefined ? BAR_MULTI : opts.bar,
    beforeEval: (win) => {
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
      // opts.holdMeasure: the look for the chapter pieces' width (every 1 s) is
      // not timed; measureTick() runs it once, measuring() tells it is set.
      if (opts.holdMeasure) {
        const nextInterval = win.setInterval.bind(win);
        const nextClear = win.clearInterval.bind(win);
        win.setInterval = (fn, ms, ...args) => {
          if (ms !== 1000) return nextInterval(fn, ms, ...args);
          measure.fn = fn;
          return measure.id;
        };
        win.clearInterval = (id) => { if (id === measure.id) { measure.fn = null; return undefined; } return nextClear(id); };
      }
    }
  }));
  const { win, doc } = env;
  const rows = () => Array.prototype.map.call(doc.querySelectorAll('.sb-segments-popup .sb-segment-row'), (r) => ({
    name: r.querySelector('.sb-segment-category').textContent,
    time: r.querySelector('.sb-segment-time').textContent,
    color: r.querySelector('.sb-segment-dot').style.backgroundColor
  }));
  const popupShown = () => {
    const p = doc.querySelector('.sb-segments-popup');
    return !!p && p.classList.contains('visible');
  };
  const pickColor = async (text, hex) => {
    const input = env.row(text).querySelector('input[type="color"]');
    input.value = hex;
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await wait(30);
  };
  return Object.assign(env, { rows, popupShown, pickColor, polls: () => polls.size,
    measureTick: () => { if (measure.fn) measure.fn(); }, measuring: () => !!measure.fn });
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
    // At the boundary, one segment each (on 600 s, 5 s and 4.9 s off would both
    // round to 9:55): 3.2 to 8.2 is 5 s and comes off the time.
    const env = await boot({ sbShowTimeWithSkips: true, sbMinSegmentLength: '5' }, [seg('sponsor', 3.2, 8.2)]);
    t(n('the time with skips removed: a segment of exactly the minimum, in fractions, comes off'), /\(9:55\)/.test(env.labelsCss()), env.labelsCss());
  }
  {
    // 13.2 to 18.1 is a tenth shorter: nothing comes off, so no time is shown.
    // A full-video label with its badge on: the badge shows, so the labels
    // were drawn for this video, and only the time is left out.
    const env = await boot({ sbShowTimeWithSkips: true, sbFullVideoLabel: true, sbMinSegmentLength: '5' },
      [seg('selfpromo', 0, 0, 'full'), seg('selfpromo', 13.2, 18.1)]);
    t(n('the time with skips removed: a segment a tenth under the minimum stays in'), !/\(\d+:\d\d\)/.test(env.labelsCss()), env.labelsCss());
    t(n('...precondition: the labels were drawn (the full-video badge shows)'), /content:"Self Promo"/.test(env.labelsCss()), env.labelsCss());
    t(n('...and the segment keeps its mark on the bar'), env.marks().length === 1, String(env.marks().length));
  }
  {
    // Never Skip on These Channels: nothing is skipped, so no time comes off.
    // The listed video has a full-video label too: its badge shows, so the
    // labels were drawn, and only the time is left out.
    const listed = await boot({ sbShowTimeWithSkips: true, sbFullVideoLabel: true, sbWhitelistChannels: ['listed channel'] },
      [seg('selfpromo', 0, 0, 'full'), seg('sponsor', 30, 60)], { author: 'Listed Channel' });
    const other = await boot({ sbShowTimeWithSkips: true, sbFullVideoLabel: true, sbWhitelistChannels: ['Other Channel'] },
      [seg('selfpromo', 0, 0, 'full'), seg('sponsor', 30, 60)], { author: 'Listed Channel' });
    t(n('the time with skips removed: control: a channel not on the list gets it, beside the same badge'),
      /\(9:30\)/.test(other.labelsCss()) && /content:"Self Promo"/.test(other.labelsCss()), other.labelsCss());
    t(n('the time with skips removed: precondition: the listed video’s labels are drawn (its full-video badge)'),
      /content:"Self Promo"/.test(listed.labelsCss()), listed.labelsCss());
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
    t(n('...the segment is offered, not skipped'), env.state.time === 30.5 && !!env.doc.querySelector('.ytaf-sb-skip-button'),
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

  // ---- A chaptered bar: the marks follow the chapters, not a plain line ----
  {
    // As on the TV (webOS 25): one piece per chapter with a margin after it,
    // beside the tracked segment element. Two 100 px chapters, a 10 px gap:
    // 210 px of bar, chapter 1 from 110 px. 600 s: 0-300 s, then 300-600 s.
    const piece = (i, mr) => `<div idomkey="chapter-${i}" style="width: 100px; margin-right: ${mr}px"></div>`;
    const BAR_CHAPTERS = '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
      `<div idomkey="progress-bar">${piece(0, 10)}${piece(1, 0)}<div idomkey="segment"></div></div>` +
      '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>';
    const env = await boot({ sbMode_highlight: 'manual_skip' },
      [seg('sponsor', 150, 450), seg('selfpromo', 60, 120), seg('poi_highlight', 300, 300, 'poi')], { bar: BAR_CHAPTERS });
    const pct = (px) => (px / 210) * 100;
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width || '0').toFixed(2)}`;
    const marks = env.marks();
    const plain = marks.filter((m) => !m.classList.contains('highlight'));
    const sponsor = plain.filter((m) => m.style.backgroundColor === rgb('#00d400'));
    t(n('chapters: a segment across the gap is one mark per chapter, each in its chapter'),
      sponsor.length === 2 && near(parseFloat(sponsor[0].style.left), pct(50)) && near(parseFloat(sponsor[0].style.width), pct(50)) &&
        near(parseFloat(sponsor[1].style.left), pct(110)) && near(parseFloat(sponsor[1].style.width), pct(50)),
      marks.map(at).join(' '));
    const other = plain.filter((m) => m.style.backgroundColor !== rgb('#00d400'));
    t(n('chapters: a segment inside the first chapter keeps to its pixels'),
      other.length === 1 && near(parseFloat(other[0].style.left), pct(20)) && near(parseFloat(other[0].style.width), pct(20)),
      marks.map(at).join(' '));
    const hl = marks.filter((m) => m.classList.contains('highlight'));
    t(n('chapters: a highlight at a chapter\'s start sits at that chapter, past the gap'),
      hl.length === 1 && near(parseFloat(hl[0].style.left), pct(110)), marks.map(at).join(' '));
    t(n('chapters: no page errors'), env.errors.length === 0, env.errors.join(' | '));
  }
  {
    // The chapter pieces drawn after the marks: drawn again over them.
    const env = await boot({}, [seg('sponsor', 150, 450)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="segment"></div></div></ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    t(n('late chapters: precondition: without chapters, the plain line'),
      env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), 25) && near(parseFloat(env.marks()[0].style.width), 50),
      env.marks().map(at).join(' '));
    const track = env.doc.querySelector('ytlr-multi-markers-player-bar-renderer [idomkey="progress-bar"]');
    track.insertAdjacentHTML('afterbegin',
      '<div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div><div idomkey="chapter-1" style="width: 100px"></div>');
    await wait(600);
    // Drawn again by the chapter observer or the bar's own check of the
    // insert, else at the overlay's sync (at most every 500 ms): any of them.
    await env.playTo(10);
    const marks = env.marks();
    t(n('late chapters: the marks are drawn again by the chapters'),
      marks.length === 2 && near(parseFloat(marks[0].style.left), (50 / 210) * 100) && near(parseFloat(marks[1].style.left), (110 / 210) * 100),
      marks.map(at).join(' '));
    // The gap grows, the widths stay: drawn again with the new gap.
    const first = track.querySelector('[idomkey="chapter-0"]');
    first.style.marginRight = '20px';
    await wait(600);
    await env.playTo(20);
    t(n('late chapters: a wider inline gap moves the marks'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (120 / 220) * 100), env.marks().map(at).join(' '));
    // A class whose CSS sets the gap, as YouTube's own.
    const style = env.doc.createElement('style');
    style.textContent = '.wide-gap { margin-right: 30px !important; }';
    env.doc.head.appendChild(style);
    first.className = 'wide-gap';
    await wait(600);
    await env.playTo(30);
    t(n('late chapters: a gap changed by a class moves the marks'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (130 / 230) * 100), env.marks().map(at).join(' '));
  }
  {
    // Chapter pieces with no width to read yet (a hidden bar, a calc() width):
    // the plain line. Once they have one, drawn again by the chapters, though
    // their signature did not change.
    const env = await boot({}, [seg('sponsor', 150, 450)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: calc(100px); margin-right: 10px"></div>' +
        '<div idomkey="chapter-1" style="width: calc(100px)"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    t(n('unmeasured chapters: precondition: the plain line'),
      env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), 25) && near(parseFloat(env.marks()[0].style.width), 50),
      env.marks().map(at).join(' '));
    // Still no width: a sync leaves the overlay as it is (no rebuild on every sync).
    const before = env.doc.getElementById('previewbar');
    await wait(600);
    await env.playTo(5);
    t(n('unmeasured chapters: no width yet, the overlay is not rebuilt'),
      !!before && env.doc.getElementById('previewbar') === before && env.marks().length === 1, env.marks().map(at).join(' '));
    // The measure poll held (its own test is below): only the position sync
    // may draw the marks again here. A timer id in place keeps it from starting.
    env.win.clearInterval(env.sb()._measureTimer);
    env.sb()._measureTimer = -1;
    for (const el of env.doc.querySelectorAll('[idomkey^="chapter-"]')) {
      Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => 100 });
    }
    await wait(600);
    await env.playTo(10);   // the overlay's own sync, at most every 500 ms
    const marks = env.marks();
    t(n('unmeasured chapters: once measurable, drawn again by the chapters'),
      marks.length === 2 && near(parseFloat(marks[0].style.left), (50 / 210) * 100) && near(parseFloat(marks[0].style.width), (50 / 210) * 100) &&
        near(parseFloat(marks[1].style.left), (110 / 210) * 100) && near(parseFloat(marks[1].style.width), (50 / 210) * 100),
      marks.map(at).join(' '));
    // Measured now: the next sync keeps the overlay (the wait is over).
    const drawn = env.doc.getElementById('previewbar');
    await wait(600);
    await env.playTo(15);
    t(n('unmeasured chapters: after the redraw, a sync keeps the overlay'),
      !!drawn && env.doc.getElementById('previewbar') === drawn && env.marks().length === 2, env.marks().map(at).join(' '));
  }
  {
    // A hidden bar with inline pixel widths: placed by them (110 of 210). A
    // stylesheet (a min-width) makes the second piece 200 px once laid out:
    // the first laid-out sync places the marks again by what they measure,
    // though their signature and the bar's own width did not change.
    const env = await boot({}, [seg('sponsor', 150, 450)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div>' +
        '<div idomkey="chapter-1" style="width: 100px"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    t(n('hidden inline widths: precondition: placed by the inline widths'),
      env.marks().length === 2 && near(parseFloat(env.marks()[0].style.left), (50 / 210) * 100) &&
        near(parseFloat(env.marks()[1].style.left), (110 / 210) * 100) && !env.sb()._chapterUnmeasured,
      env.marks().map(at).join(' '));
    const [a, b] = env.doc.querySelectorAll('[idomkey^="chapter-"]');
    Object.defineProperty(a, 'offsetWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(b, 'offsetWidth', { configurable: true, get: () => 200 });
    await wait(600);
    await env.playTo(10);   // the overlay's own sync, at most every 500 ms
    const marks = env.marks();
    // Chapter 0 spans 0-200 s (100 of 300 px), chapter 1 200-600 s.
    t(n('hidden inline widths: the first laid-out sync places them by the measured widths'),
      marks.length === 2 && near(parseFloat(marks[0].style.left), (75 / 310) * 100) && near(parseFloat(marks[0].style.width), (25 / 310) * 100) &&
        near(parseFloat(marks[1].style.left), (110 / 310) * 100) && near(parseFloat(marks[1].style.width), (125 / 310) * 100),
      marks.map(at).join(' '));
    const drawn = env.doc.getElementById('previewbar');
    await wait(600);
    await env.playTo(15);
    t(n('hidden inline widths: after the redraw, a sync keeps the overlay'),
      !!drawn && env.doc.getElementById('previewbar') === drawn && env.marks().length === 2, env.marks().map(at).join(' '));
  }
  {
    // Shown on the seek bar only (no skip, so no time listener) and the bar
    // made visible by a parent: no sync comes, yet the marks follow the
    // chapters once the pieces have a width (no playback here). The look is
    // run by hand (holdMeasure), not by a real 1 s timer.
    const env = await boot({ sbMode_sponsor: 'seek_bar' }, [seg('sponsor', 150, 450)], {
      holdMeasure: true,
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: calc(100px); margin-right: 10px"></div>' +
        '<div idomkey="chapter-1" style="width: calc(100px)"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    t(n('no sync: precondition: hidden, the plain line, and a look scheduled'),
      env.marks().length === 1 && env.measuring(), env.marks().map(at).join(' '));
    env.measureTick();
    t(n('no sync: a look with no width yet draws nothing new'), env.marks().length === 1 && env.measuring(), env.marks().map(at).join(' '));
    for (const el of env.doc.querySelectorAll('[idomkey^="chapter-"]')) {
      Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => 100 });
    }
    env.measureTick();
    const marks = env.marks();
    t(n('no sync: once the pieces have a width, the marks follow the chapters'),
      marks.length === 2 && near(parseFloat(marks[0].style.left), (50 / 210) * 100) && near(parseFloat(marks[1].style.left), (110 / 210) * 100),
      marks.map(at).join(' '));
    env.measureTick();
    t(n('no sync: and the look stops'), !env.measuring() && !env.sb()._measureTimer);
  }
  {
    // A hidden bar, one piece sized inline (100px), one by a stylesheet (no
    // inline width): not drawn by the inline one alone, but once laid out,
    // with no sync (seek bar only, no playback; the look run by hand).
    const env = await boot({ sbMode_sponsor: 'seek_bar' }, [seg('sponsor', 150, 450)], {
      holdMeasure: true,
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div>' +
        '<div idomkey="chapter-1"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    t(n('stylesheet width: precondition: hidden, the plain line, and a look scheduled'),
      env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), 25) && env.measuring(), env.marks().map(at).join(' '));
    for (const el of env.doc.querySelectorAll('[idomkey^="chapter-"]')) {
      Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => 100 });
    }
    env.measureTick();
    const marks = env.marks();
    t(n('stylesheet width: once laid out, the marks follow both pieces'),
      marks.length === 2 && near(parseFloat(marks[0].style.left), (50 / 210) * 100) && near(parseFloat(marks[1].style.left), (110 / 210) * 100),
      marks.map(at).join(' '));
  }
  {
    // A relative width on a hidden bar is not a pixel width: one piece in
    // pixels and one in percent wait for the layout, then follow it.
    const env = await boot({}, [seg('sponsor', 150, 450)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div>' +
        '<div idomkey="chapter-1" style="width: 50%"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    t(n('relative chapter width: while hidden, the plain line'),
      env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), 25) && near(parseFloat(env.marks()[0].style.width), 50),
      env.marks().map(at).join(' '));
    const [first, second] = env.doc.querySelectorAll('[idomkey^="chapter-"]');
    Object.defineProperty(first, 'offsetWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(second, 'offsetWidth', { configurable: true, get: () => 200 });
    await wait(600);
    await env.playTo(10);
    // 310 px in all: 0-200 s in 0-100 px, then a 10 px gap, 200-600 s in 110-310 px.
    const pct = (px) => (px / 310) * 100;
    const marks = env.marks();
    t(n('relative chapter width: once laid out, the marks follow the measured pieces'),
      marks.length === 2 && near(parseFloat(marks[0].style.left), pct(75)) && near(parseFloat(marks[0].style.width), pct(25)) &&
        near(parseFloat(marks[1].style.left), pct(110)) && near(parseFloat(marks[1].style.width), pct(125)),
      marks.map(at).join(' '));
  }
  {
    // A piece at 0% on a bar that is laid out (a chapter too short to draw):
    // it is 0 px, not waiting for a width. The wait and its retry used to
    // send each other round until the stack ran out.
    const env = await boot({}, [seg('sponsor', 150, 450)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div>' +
        '<div idomkey="chapter-1" style="width: 0%"></div>' +
        '<div idomkey="chapter-2" style="width: 100px"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    t(n('0% piece: precondition: hidden, the plain line'), env.marks().length === 1, env.marks().map(at).join(' '));
    const [a, b, c] = env.doc.querySelectorAll('[idomkey^="chapter-"]');
    Object.defineProperty(a, 'offsetWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(b, 'offsetWidth', { configurable: true, get: () => 0 });
    Object.defineProperty(c, 'offsetWidth', { configurable: true, get: () => 100 });
    await wait(600);
    await env.playTo(10);
    // 210 px: 0-300 s in 0-100 px, the 0 px piece, 300-600 s in 110-210 px.
    const pct = (px) => (px / 210) * 100;
    const marks = env.marks();
    t(n('0% piece: laid out, the marks follow the other pieces, with no page error'),
      env.errors.length === 0 && marks.length === 2 && near(parseFloat(marks[0].style.left), pct(50)) &&
        near(parseFloat(marks[0].style.width), pct(50)) && near(parseFloat(marks[1].style.left), pct(110)) &&
        near(parseFloat(marks[1].style.width), pct(50)),
      env.errors.join(' | ') + ' ' + marks.map(at).join(' '));
  }
  {
    // The renderer tracked as the bar (no segment or progress-bar element):
    // the pieces deeper inside are still found.
    const env = await boot({}, [seg('sponsor', 150, 450)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer><div class="row">' +
        '<div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div><div idomkey="chapter-1" style="width: 100px"></div>' +
        '</div></ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    const marks = env.marks();
    t(n('renderer as the bar: precondition: it is the tracked element'),
      !!env.sb().progressBar && env.sb().progressBar.tagName === 'YTLR-MULTI-MARKERS-PLAYER-BAR-RENDERER',
      env.sb().progressBar && env.sb().progressBar.tagName);
    t(n('renderer as the bar: its chapter pieces place the marks'),
      marks.length === 2 && near(parseFloat(marks[1].style.left), (110 / 210) * 100), marks.map(at).join(' '));
  }
  {
    // The renderer as the bar, shown on the seek bar only (no time listener):
    // YouTube replaces the whole chapter row with an equal one. The renderer
    // stays, so nothing redraws; the new row's later gap still moves the marks.
    const env = await boot({ sbMode_sponsor: 'seek_bar' }, [seg('sponsor', 150, 450)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer><div class="row">' +
        '<div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div><div idomkey="chapter-1" style="width: 100px"></div>' +
        '</div></ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    const renderer = env.doc.querySelector('ytlr-multi-markers-player-bar-renderer');
    t(n('renderer row replaced: precondition: the renderer is the bar, drawn by the chapters'),
      env.sb().progressBar === renderer && env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (110 / 210) * 100),
      env.marks().map(at).join(' '));
    const row = env.doc.querySelector('.row');
    const fresh = row.cloneNode(true);
    row.parentNode.replaceChild(fresh, row);
    // The bar's check of the replace (on an animation frame) over before the
    // gap changes: only an observer on the new row's piece can move the marks.
    await wait(100);
    await new Promise((r) => env.win.requestAnimationFrame(() => env.win.requestAnimationFrame(r)));
    await wait(50);
    t(n('renderer row replaced: the same pieces, the marks unchanged'),
      env.sb().progressBar === renderer && !row.isConnected && env.marks().length === 2 &&
        near(parseFloat(env.marks()[1].style.left), (110 / 210) * 100), env.marks().map(at).join(' '));
    fresh.querySelector('[idomkey="chapter-0"]').style.marginRight = '30px';
    await wait(300);
    t(n('renderer row replaced: the new row is watched, its new gap moves the marks'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (130 / 230) * 100), env.marks().map(at).join(' '));
  }
  {
    // The same with no chapter-0 among the pieces (keyed from 1): still found.
    const env = await boot({}, [seg('sponsor', 150, 450)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer><div class="row">' +
        '<div idomkey="chapter-1" style="width: 100px; margin-right: 10px"></div><div idomkey="chapter-2" style="width: 100px"></div>' +
        '</div></ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    const marks = env.marks();
    t(n('renderer as the bar, no chapter-0: its pieces place the marks'),
      marks.length === 2 && near(parseFloat(marks[1].style.left), (110 / 210) * 100), marks.map(at).join(' '));
  }
  {
    // Laid out, with margins that take the whole length back (negative
    // margins are valid CSS): the plain line at once, with no look for a
    // width and no draw and sync calling each other.
    const env = await boot({}, [seg('sponsor', 150, 450)], {
      holdMeasure: true,
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: -100px"></div>' +
        '<div idomkey="chapter-1" style="width: 100px; margin-left: -100px"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    for (const el of env.doc.querySelectorAll('[idomkey^="chapter-"]')) {
      Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => 100 });
    }
    env.sb().lastOverlayHash = null;
    env.sb().drawOverlay();
    await wait(600);
    await env.playTo(5);
    t(n('zero extent: laid out, the plain line'), env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), 25),
      env.marks().map((m) => m.style.left).join());
    // The look set while hidden ends at its next step: nothing to wait for.
    env.measureTick();
    t(n('zero extent: the look for a width ends, no page error'), !env.measuring() && !env.sb()._chapterUnmeasured && env.errors.length === 0,
      env.errors.join(' | '));
  }

  {
    // A hidden bar with a relative margin: not read as pixels (a hidden
    // subtree gives "1%" back as it is), so the plain line until laid out.
    const env = await boot({ sbMode_sponsor: 'seek_bar' }, [seg('sponsor', 150, 450)], {
      holdMeasure: true,
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: 5%"></div>' +
        '<div idomkey="chapter-1" style="width: 100px"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    t(n('relative margin: hidden, the plain line and a look scheduled'),
      env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), 25) && env.measuring(), env.marks().map(at).join(' '));
    // Laid out: the piece's margin as computed then (10 px in this layout).
    const [a, b] = env.doc.querySelectorAll('[idomkey^="chapter-"]');
    Object.defineProperty(a, 'offsetWidth', { configurable: true, get: () => 100 });
    Object.defineProperty(b, 'offsetWidth', { configurable: true, get: () => 100 });
    const realStyle = env.win.getComputedStyle.bind(env.win);
    env.win.getComputedStyle = (el, ...rest) => {
      const cs = realStyle(el, ...rest);
      return el === a ? { marginLeft: '0px', marginRight: '10px', getPropertyValue: (p) => cs.getPropertyValue(p) } : cs;
    };
    env.measureTick();
    const marks = env.marks();
    t(n('relative margin: once laid out, the marks follow the chapters'),
      marks.length === 2 && near(parseFloat(marks[1].style.left), (110 / 210) * 100), marks.map(at).join(' '));
  }
  {
    // The look for a width ends at a draw with no marks at all (the segments
    // gone), not only at one drawn by the chapters.
    const env = await boot({ sbMode_sponsor: 'seek_bar' }, [seg('sponsor', 150, 450)], {
      holdMeasure: true,
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: calc(100px); margin-right: 10px"></div>' +
        '<div idomkey="chapter-1" style="width: calc(100px)"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    t(n('look ends: precondition: a look scheduled'), env.measuring());
    env.sb().segments = [];
    env.sb().drawOverlay();
    env.measureTick();
    t(n('look ends: a draw with no segments stops it'), !env.measuring() && !env.sb()._measureTimer);
  }
  {
    // Chapter pieces changed while the duration is not known: the marks
    // wait for it, and the overlay still follows the bar meanwhile.
    const env = await boot({}, [seg('sponsor', 150, 450)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div>' +
        '<div idomkey="chapter-1" style="width: 100px"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    await wait(600);
    await env.playTo(5);
    const overlay = env.doc.getElementById('previewbar');
    const bar = env.sb().progressBar;
    t(n('no duration: precondition: an overlay on a tracked bar'), !!overlay && !!bar);
    env.state.duration = NaN;
    env.doc.querySelector('[idomkey="chapter-0"]').style.marginRight = '20px';
    Object.defineProperty(bar, 'offsetWidth', { configurable: true, get: () => 333 });
    await wait(600);
    await env.playTo(10);
    t(n('no duration: the overlay still takes the bar\'s width'),
      env.doc.getElementById('previewbar') === overlay && overlay.style.width === '333px', overlay.style.width);
  }
  {
    // The renderer leaves out another chapter, with the same two pieces in the
    // DOM: the pieces now mean other chapters, and the marks move.
    const host = '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
      '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div>' +
      '<div idomkey="chapter-1" style="width: 100px"></div><div idomkey="segment"></div></div>' +
      '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>';
    const env = await boot({}, [seg('sponsor', 300, 330)], { bar: host });
    const renderer = env.doc.querySelector('ytlr-multi-markers-player-bar-renderer');
    renderer.__instance = { props: { data: { chapters: [{ start: 0, width: 100 }, { start: 200, width: 100 }, { start: 400, width: 0 }] } } };
    await wait(600);
    await env.playTo(5);
    const pct = (px) => (px / 210) * 100;
    // 0-200 s in 0-100 px, 200-600 s in 110-210 px: 300 s at 110 + 100 * 100/400 = 135 px.
    t(n('drawn chapters: precondition: placed by the chapters drawn'),
      env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), pct(135)), env.marks().map((m) => m.style.left).join());
    renderer.__instance = { props: { data: { chapters: [{ start: 0, width: 100 }, { start: 200, width: 0 }, { start: 400, width: 100 }] } } };
    await wait(600);
    await env.playTo(10);
    // Now 0-400 s in 0-100 px: 300 s at 75 px.
    t(n('drawn chapters: another chapter left out, same pieces: the marks move'),
      env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), pct(75)), env.marks().map((m) => m.style.left).join());
  }
  {
    // Pieces with a relative width on a bar that grows: their measured widths
    // grow with it, and the marks follow at the next sync.
    const host = '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
      '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 50%; margin-right: 10px"></div>' +
      '<div idomkey="chapter-1" style="width: 50%"></div><div idomkey="segment"></div></div>' +
      '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>';
    const env = await boot({}, [seg('sponsor', 150, 450)], { bar: host });
    const [a, b] = env.doc.querySelectorAll('[idomkey^="chapter-"]');
    let piece = 100;
    Object.defineProperty(a, 'offsetWidth', { configurable: true, get: () => piece });
    Object.defineProperty(b, 'offsetWidth', { configurable: true, get: () => piece });
    const bar = env.sb().progressBar;
    Object.defineProperty(bar, 'offsetWidth', { configurable: true, get: () => piece * 2 + 10 });
    await wait(1300);
    await env.playTo(5);
    t(n('resized bar: precondition: marks by the pieces at 100 px'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (110 / 210) * 100), env.marks().map((m) => m.style.left).join());
    piece = 200;
    await wait(600);
    await env.playTo(10);
    t(n('resized bar: the pieces at 200 px, the marks follow'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (210 / 410) * 100), env.marks().map((m) => m.style.left).join());
    // Hidden by a parent: the bar and its pieces at 0 px. No redraw then (the
    // relative pieces have nothing to read), and none when it is back at the
    // same width.
    const drawn = env.doc.getElementById('previewbar');
    const width = piece;
    Object.defineProperty(bar, 'offsetWidth', { configurable: true, get: () => (piece ? piece * 2 + 10 : 0) });
    piece = 0;
    await wait(600);
    await env.playTo(15);
    t(n('resized bar: hidden (0 px), the marks are not drawn again'),
      env.doc.getElementById('previewbar') === drawn && env.marks().length === 2, env.marks().map((m) => m.style.left).join());
    piece = width;
    await wait(600);
    await env.playTo(20);
    t(n('resized bar: shown again at its width, still not drawn again'),
      env.doc.getElementById('previewbar') === drawn && env.marks().length === 2 &&
        near(parseFloat(env.marks()[1].style.left), (210 / 410) * 100), env.marks().map((m) => m.style.left).join());
  }
  {
    // A first piece YouTube keeps at 0 px, with its start time in the
    // renderer's data: the first piece shown starts at 0, so a segment at the
    // start of the video has its mark.
    const env = await boot({}, [seg('sponsor', 5, 50)], {
      bar: '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
        '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 0px"></div>' +
        '<div idomkey="chapter-1" style="width: 100px; margin-right: 10px"></div>' +
        '<div idomkey="chapter-2" style="width: 100px"></div><div idomkey="segment"></div></div>' +
        '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>'
    });
    env.doc.querySelector('ytlr-multi-markers-player-bar-renderer').__instance =
      { props: { data: { chapters: [{ start: 0 }, { start: 10 }, { start: 200 }] } } };
    await wait(600);
    await env.playTo(1);
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    // 210 px: 0-200 s in 0-100 px, 200-600 s in 110-210 px.
    const pct = (px) => (px / 210) * 100;
    const marks = env.marks();
    t(n('a 0 px first piece: the first piece shown starts at 0, the mark covers 5-50 s'),
      marks.length === 1 && near(parseFloat(marks[0].style.left), pct(2.5)) && near(parseFloat(marks[0].style.width), pct(22.5)),
      marks.map(at).join(' '));
  }

  // ---- Chapter start times from the renderer ----
  {
    // The renderer's start times place the chapters, not the pieces' widths:
    // two 100 px pieces, a 10 px gap, the second chapter from 200 s of 600.
    const host = '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
      '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div>' +
      '<div idomkey="chapter-1" style="width: 100px"></div><div idomkey="segment"></div></div>' +
      '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>';
    const pct = (px) => (px / 210) * 100;
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    const env = await boot({}, [seg('sponsor', 150, 450)], { bar: host });
    env.doc.querySelector('ytlr-multi-markers-player-bar-renderer').__instance =
      { props: { data: { chapters: [{ start: 0 }, { start: 200 }] } } };
    await wait(600);
    await env.playTo(10);
    const marks = env.marks();
    t(n('start times: each chapter spans its own times'),
      marks.length === 2 && near(parseFloat(marks[0].style.left), pct(75)) && near(parseFloat(marks[0].style.width), pct(25)) &&
        near(parseFloat(marks[1].style.left), pct(110)) && near(parseFloat(marks[1].style.width), pct(62.5)),
      marks.map(at).join(' '));
    // The same number of chapters, other start times: drawn again by the new times.
    env.doc.querySelector('ytlr-multi-markers-player-bar-renderer').__instance =
      { props: { data: { chapters: [{ start: 0 }, { start: 300 }] } } };
    await wait(600);
    await env.playTo(15);
    t(n('start times: new times with the same count move the marks'),
      env.marks().length === 2 && near(parseFloat(env.marks()[0].style.left), pct(50)) && near(parseFloat(env.marks()[0].style.width), pct(50)),
      env.marks().map(at).join(' '));
    // Fewer pieces than chapters (a long video): which piece is which is not known.
    env.doc.querySelector('ytlr-multi-markers-player-bar-renderer').__instance =
      { props: { data: { chapters: [{ start: 0 }, { start: 200 }, { start: 400 }] } } };
    await wait(600);
    await env.playTo(20);
    t(n('start times: a bar with only some of the chapters gets the plain line'),
      env.marks().length === 1 && near(parseFloat(env.marks()[0].style.left), 25) && near(parseFloat(env.marks()[0].style.width), 50),
      env.marks().map(at).join(' '));
    // The bar leaves out a chapter too short to draw (width 0 in the data, as
    // on the TV: a 7 s introduction): the pieces are the other chapters, and
    // the first one starts at 0.
    env.doc.querySelector('ytlr-multi-markers-player-bar-renderer').__instance =
      { props: { data: { chapters: [{ start: 0, width: 0 }, { start: 10, width: 100 }, { start: 200, width: 100 }] } } };
    await wait(600);
    await env.playTo(25);
    const left = env.marks();
    t(n('start times: a chapter the bar leaves out is skipped, the others keep their pieces'),
      left.length === 2 && near(parseFloat(left[0].style.left), pct(75)) && near(parseFloat(left[0].style.width), pct(25)) &&
        near(parseFloat(left[1].style.left), pct(110)) && near(parseFloat(left[1].style.width), pct(62.5)),
      left.map(at).join(' '));
  }
  {
    // Only shown in the bar (no skip left to keep the time listener on): a
    // gap that changes still moves the marks.
    const host = '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
      '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: 100px; margin-right: 10px"></div>' +
      '<div idomkey="chapter-1" style="width: 100px"></div><div idomkey="segment"></div></div>' +
      '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>';
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    const env = await boot({ sbMode_sponsor: 'seek_bar' }, [seg('sponsor', 150, 450)], { bar: host });
    t(n('seek bar only: precondition: drawn by the chapters'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (110 / 210) * 100), env.marks().map(at).join(' '));
    env.doc.querySelector('[idomkey="chapter-0"]').style.marginRight = '20px';
    await wait(300);
    t(n('seek bar only: a wider gap moves the marks with no playback'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (120 / 220) * 100), env.marks().map(at).join(' '));
    // YouTube replaces the pieces with equal ones: their later gap counts too.
    const old = env.doc.querySelector('[idomkey="chapter-0"]');
    const fresh = old.cloneNode(true);
    old.parentNode.replaceChild(fresh, old);
    // The bar's own check of the replace (on an animation frame) over before
    // the gap changes: only the observer on the new piece can then move the
    // marks.
    await wait(100);
    await new Promise((r) => env.win.requestAnimationFrame(() => env.win.requestAnimationFrame(r)));
    await wait(50);
    fresh.style.marginRight = '30px';
    await wait(300);
    t(n('seek bar only: a replaced piece is watched, its new gap moves the marks'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (130 / 230) * 100), env.marks().map(at).join(' '));
  }
  {
    // Pieces sized by percent: a resize changes their measured width and no
    // attribute, so only the resize itself can redraw the marks.
    const host = '<div class="bar-host"><ytlr-progress-bar><ytlr-multi-markers-player-bar-renderer>' +
      '<div idomkey="progress-bar"><div idomkey="chapter-0" style="width: calc(50% - 5px); margin-right: 10px"></div>' +
      '<div idomkey="chapter-1" style="width: calc(50% - 5px)"></div><div idomkey="segment"></div></div>' +
      '</ytlr-multi-markers-player-bar-renderer></ytlr-progress-bar></div>';
    const at = (m) => `${parseFloat(m.style.left).toFixed(2)}/${parseFloat(m.style.width).toFixed(2)}`;
    const env = await boot({}, [seg('sponsor', 150, 450)], { bar: host });
    const pieces = env.doc.querySelectorAll('[idomkey^="chapter-"]');
    const measure = (px) => {
      for (const p of pieces) Object.defineProperty(p, 'offsetWidth', { configurable: true, get: () => px });
    };
    measure(100);
    env.win.dispatchEvent(new env.win.Event('resize'));
    await wait(30);
    t(n('resize: precondition: placed by the measured width'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (110 / 210) * 100), env.marks().map(at).join(' '));
    measure(200);
    env.win.dispatchEvent(new env.win.Event('resize'));
    await wait(30);
    t(n('resize: a wider bar moves the marks'),
      env.marks().length === 2 && near(parseFloat(env.marks()[1].style.left), (210 / 410) * 100), env.marks().map(at).join(' '));
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
