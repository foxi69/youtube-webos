/**
 * Auto-translated subtitles (src/subtitle-translate.js), in the bundle: the
 * edits to the /player response (the chosen language pinned to the top of
 * Auto-translate, a ready-made "<Language> (auto-translated)" track where the
 * video has none in it) and Subtitles When a Video Starts: Translated
 * through the player's captions API (which track it picks, a track already
 * on, no track in the language, a tracklist that comes late or never, a
 * reset by the player, another video).
 *
 * review-fixes-test covers the tile preview on Home, a key press after the
 * track is on and a video opened a second time; none of that is repeated here.
 * Before this test nothing ran the response edits at all.
 *
 *   node bench/subtitle-translate-test.cjs <bundle> [legacy|modern]
 *
 * The player is a stand-in element with the API the modules call; its
 * state changes go through video-quality.js, which publishes them to the
 * subtitles as on the TV. The page's timers run ten times faster.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, dispatchTrusted, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();

const VIDEO = 'abcdefghijk';
const VIDEO2 = 'zyxwvutsrqp';
const PLAYER_ID = 'ytlr-player__player-container-player';
const SPEED = 10;

const { t, run } = createReporter();

/** A caption track as the /player response lists it. */
function track(lang, extra = {}) {
  const asr = extra.kind === 'asr';
  return Object.assign({
    baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=${lang}${asr ? '&kind=asr' : ''}&signature=SIG&expire=1`,
    name: { runs: [{ text: lang }] },
    vssId: (asr ? 'a.' : '.') + lang,
    languageCode: lang,
    isTranslatable: true
  }, extra);
}
const tl = (lang, text, shape = 'runs') =>
  ({ languageCode: lang, languageName: shape === 'runs' ? { runs: [{ text }] } : { simpleText: text } });

/** A /player response: long enough for the hook to look at it. */
function response(renderer, videoId = VIDEO, nested = false) {
  const body = { videoDetails: { videoId }, captions: { playerCaptionsTracklistRenderer: renderer } };
  return JSON.stringify(Object.assign(nested ? { playerResponse: body } : body, { pad: 'x'.repeat(1200) }));
}

/** The stand-in player: what video-quality.js and the subtitles ask of it. */
function stubPlayer(el, opts) {
  const p = {
    listeners: [], state: -1, videoId: VIDEO, track: opts.track || null, tracklist: opts.tracklist || [],
    sets: [], loads: [], listAsked: 0, throwOnSet: false, startListeners: [], started: null, setAt: []
  };
  Object.assign(el, {
    setPlaybackQualityRange() {}, setPlaybackQuality() {},
    getPlaybackQuality: () => 'hd720', getPlaybackQualityLabel: () => '720p',
    getAvailableQualityLevels: () => ['hd720', 'auto'],
    getVideoData: () => ({ video_id: p.videoId }),
    getPlayerState: () => p.state, pauseVideo() {}, playVideo() {}, isInline: () => false,
    loadModule: (m) => { p.loads.push(m); },
    getOption: (m, name) => {
      if (m !== 'captions') return null;
      if (name === 'track') return p.track;
      if (name === 'tracklist') { p.listAsked++; return typeof p.tracklist === 'function' ? p.tracklist() : p.tracklist; }
      return null;
    },
    setOption: (m, name, value) => {
      if (m !== 'captions' || name !== 'track') return;
      p.sets.push(value);
      p.setAt.push(Date.now());
      if (p.throwOnSet) throw new Error('captions module busy');
      p.track = value;
    },
    addEventListener(type, fn) {
      if (type === 'onStateChange') p.listeners.push(fn);
      if (type === 'onPlaybackStartExternal') p.startListeners.push(fn);
    },
    removeEventListener(type, fn) { p.listeners = p.listeners.filter((f) => f !== fn); }
  });
  // As the TV player: PLAYING, then onPlaybackStartExternal, after which the
  // app sets its own start-up subtitles (opts.appDecision, 1 s later).
  p.emit = (state) => {
    p.state = state;
    p.listeners.slice().forEach((fn) => { fn(state); });
    if (state !== 1 || opts.noStartEvent || p.started === p.videoId) return;
    p.started = p.videoId;
    p.startListeners.slice().forEach((fn) => { fn(); });
    if (opts.appDecision) p.win.setTimeout(() => opts.appDecision(p), 1000);
  };
  return p;
}

async function boot(cfg, opts = {}) {
  const warnings = [];
  const page = opts.page || 'WEB_PAGE_TYPE_WATCH';
  const { win, errors, evaluate } = bootPage({
    code,
    bodyClass: page,
    inner: `\n    <div id="${PLAYER_ID}"><video></video></div>`,
    url: `https://www.youtube.com/tv#/${page === 'WEB_PAGE_TYPE_SHORTS' ? 'shorts/' : 'watch?v='}${VIDEO}`,
    ignoreNavigation: true,
    console: { warn: (...a) => warnings.push(a.map(String).join(' ')) },
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, showVideoQuality: 'off'
    }, cfg),
    fetch: 'pending',
    evaluate: false
  });
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 1);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  const st = win.setTimeout.bind(win);
  const si = win.setInterval.bind(win);
  win.setTimeout = (fn, ms, ...a) => st(fn, (ms || 0) / SPEED, ...a);
  win.setInterval = (fn, ms, ...a) => si(fn, (ms || 0) / SPEED, ...a);
  const p = stubPlayer(win.document.getElementById(PLAYER_ID), opts);
  p.win = win;
  evaluate();
  // video-quality.js attaches to the player: its state changes reach the subtitles.
  for (let i = 0; i < 100 && !p.listeners.length; i++) await wait(10);
  /** Parses `text` in the page, through every JSON.parse hook it installed. */
  const parse = (text) => win.JSON.parse(text);
  return { win, p, errors, warnings, parse };
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ================= The /player response =================
  {
    const env = await boot({ subtitleTranslateLang: 'hu' });
    t(n('the player stand-in is attached'), env.p.listeners.length === 1, `listeners=${env.p.listeners.length}`);

    // An ASR track first, then a human one; Hungarian in neither.
    const asr = track('en', { kind: 'asr' });
    delete asr.isTranslatable;   // the TV client leaves the flag out
    const res = env.parse(response({
      captionTracks: [asr, track('de', { name: { runs: [{ text: 'Deutsch' }] } })],
      translationLanguages: [tl('en', 'English'), tl('de', 'German'), tl('fr', 'French')],
      audioTracks: [{ captionTrackIndices: [0, 1] }, { captionTrackIndices: [1] }, {}]
    }));
    const r = res.captions.playerCaptionsTracklistRenderer;
    const langs = r.translationLanguages.map((l) => l.languageCode).join(',');
    t(n('the chosen language is added to Auto-translate, at the top'), langs === 'hu,en,de,fr', langs);
    t(n('...named in the language itself, in the shape the list uses'),
      JSON.stringify(r.translationLanguages[0].languageName) === '{"runs":[{"text":"Magyar"}]}',
      JSON.stringify(r.translationLanguages[0]));
    t(n('an ASR track without the translatable flag gets it'), r.captionTracks[0].isTranslatable === true);
    t(n('a "Magyar (auto-translated)" track is added'), r.captionTracks.length === 3, String(r.captionTracks.length));
    const added = r.captionTracks[2] || {};
    let url = null;
    try { url = new URL(added.baseUrl); } catch { /* checked below */ }
    t(n('...with tlang=hu on the URL'), !!url && url.searchParams.get('tlang') === 'hu', added.baseUrl);
    t(n('...made from the human track, not the ASR one before it'),
      !!url && url.searchParams.get('lang') === 'de' && !url.searchParams.get('kind'), added.baseUrl);
    t(n('...keeping the signature of the URL it was made from'), !!url && url.searchParams.get('signature') === 'SIG', added.baseUrl);
    t(n('...as a clean Hungarian track of its own'),
      added.languageCode === 'hu' && added.vssId === '.hu' && added.isTranslatable === false && !('kind' in added) &&
      added.trackName === 'Magyar (auto-translated)' &&
      JSON.stringify(added.name) === '{"runs":[{"text":"Magyar (auto-translated)"}]}', JSON.stringify(added));
    t(n('...on every audio track that lists caption tracks'),
      r.audioTracks[0].captionTrackIndices.join() === '0,1,2' && r.audioTracks[1].captionTrackIndices.join() === '1,2' &&
      !('captionTrackIndices' in r.audioTracks[2]), JSON.stringify(r.audioTracks));

    // Hungarian already in the list, far down: moved up, not added twice.
    // Names given as simpleText: the new track's name follows.
    const res2 = env.parse(response({
      captionTracks: [track('en', { name: { simpleText: 'English' } })],
      translationLanguages: [tl('en', 'English', 'simple'), tl('de', 'German', 'simple'), tl('hu', 'Hungarian', 'simple'), tl('fr', 'French', 'simple')]
    }));
    const r2 = res2.captions.playerCaptionsTracklistRenderer;
    t(n('a language already in the list is moved to the top, not added twice'),
      r2.translationLanguages.map((l) => l.languageCode).join() === 'hu,en,de,fr' &&
      r2.translationLanguages[0].languageName.simpleText === 'Hungarian', JSON.stringify(r2.translationLanguages));
    t(n('a simpleText name is copied as simpleText'),
      JSON.stringify((r2.captionTracks[1] || {}).name) === '{"simpleText":"Magyar (auto-translated)"}', JSON.stringify(r2.captionTracks[1]));

    // The video has Hungarian (as hu-HU): nothing to add.
    const r3 = env.parse(response({
      captionTracks: [track('en'), track('hu-HU')], translationLanguages: [tl('en', 'English')]
    })).captions.playerCaptionsTracklistRenderer;
    t(n('a video with a hu-HU track gets no auto-translated one'), r3.captionTracks.length === 2, JSON.stringify(r3.captionTracks.map((c) => c.vssId)));

    // Only ASR to translate from: that is used.
    const r4 = env.parse(response({
      captionTracks: [track('en', { kind: 'asr' })], translationLanguages: [tl('en', 'English')]
    })).captions.playerCaptionsTracklistRenderer;
    const u4 = r4.captionTracks[1] ? new URL(r4.captionTracks[1].baseUrl) : null;
    t(n('with only an ASR track, it is the one translated'),
      !!u4 && u4.searchParams.get('kind') === 'asr' && u4.searchParams.get('tlang') === 'hu', r4.captionTracks[1] && r4.captionTracks[1].baseUrl);

    // Nothing translatable: no dead entries.
    const r5 = env.parse(response({
      captionTracks: [track('en', { isTranslatable: false })], translationLanguages: []
    })).captions.playerCaptionsTracklistRenderer;
    t(n('no translatable track and an empty list: nothing added'),
      r5.captionTracks.length === 1 && r5.translationLanguages.length === 0, JSON.stringify(r5));

    // The response inside a playerResponse (the shape of a watch-next answer).
    const r6 = env.parse(response({ captionTracks: [track('en')], translationLanguages: [tl('en', 'English')] }, VIDEO, true))
      .playerResponse.captions.playerCaptionsTracklistRenderer;
    t(n('a response inside playerResponse is edited too'),
      r6.captionTracks.length === 2 && r6.translationLanguages[0].languageCode === 'hu', JSON.stringify(r6.translationLanguages));

    // No captions: the response as it came.
    const plain = response({}).replace('"captions":{"playerCaptionsTracklistRenderer":{}},', '');
    t(n('a response with no captions is left as it came'),
      JSON.stringify(env.parse(plain)) === JSON.stringify(JSON.parse(plain)) && plain.indexOf('captions') === -1);
    // A small blob (under 1000 characters) is not looked at.
    const small = JSON.stringify({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [track('en')], translationLanguages: [tl('en', 'English')] } } });
    t(n('a small blob with captions is not edited'), JSON.stringify(env.parse(small)) === small, String(small.length));
    t(n('response edits: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  // A language with a dash: zh-Hans is not zh-Hant.
  {
    const env = await boot({ subtitleTranslateLang: 'zh-Hans' });
    const r = env.parse(response({
      captionTracks: [track('zh-Hant')], translationLanguages: [tl('zh-Hant', 'Chinese (Traditional)')]
    })).captions.playerCaptionsTracklistRenderer;
    t(n('zh-Hans: a zh-Hant track does not count, a zh-Hans one is added'),
      r.captionTracks.length === 2 && r.captionTracks[1].vssId === '.zh-Hans' &&
      r.translationLanguages[0].languageName.runs[0].text === '中文 简体', JSON.stringify(r.captionTracks.map((c) => c.vssId)));
    env.win.close();
  }

  // Off, or a language the setting does not offer: the response is not touched.
  for (const lang of ['off', 'xx']) {
    const env = await boot({ subtitleTranslateLang: lang });
    const text = response({ captionTracks: [track('en')], translationLanguages: [tl('en', 'English')] });
    t(n(`language "${lang}": the response is left as it came`), JSON.stringify(env.parse(text)) === JSON.stringify(JSON.parse(text)));
    env.win.close();
  }

  // ================= Turning the subtitles on =================
  const AUTO = { subtitleTranslateLang: 'hu', subtitlesAtStart: 'translated' };
  const huAsr = { languageCode: 'hu', kind: 'asr', vss_id: 'a.hu' };
  const huHuman = { languageCode: 'hu', vss_id: '.hu' };
  const huTranslated = { languageCode: 'en', vss_id: '.en', translationLanguage: { languageCode: 'hu' } };
  // A real time for N of the page's (sped up) milliseconds.
  const pageMs = (ms) => wait(ms / SPEED + 20);

  {
    const env = await boot(AUTO, { tracklist: [{ languageCode: 'en', vss_id: '.en' }, huTranslated, huAsr, huHuman] });
    const { p } = env;
    p.emit(1);
    await pageMs(100);
    t(n('just after the start: nothing yet (the app sets its own subtitles first)'), p.sets.length === 0 && p.loads.length === 0,
      JSON.stringify(p.sets));
    await pageMs(1150);
    t(n('on PLAYING the captions module is loaded'), p.loads.indexOf('captions') !== -1, p.loads.join());
    t(n('the human Hungarian track is turned on, once'), p.sets.length === 1 && p.sets[0] === p.tracklist[3],
      JSON.stringify(p.sets));

    // The player drops the track by itself while its captions settle: put back once.
    p.track = null;
    await pageMs(700);
    t(n('the track dropped by the player is put back'), p.sets.length === 2 && p.track === p.tracklist[3], JSON.stringify(p.sets));
    p.track = null;
    await pageMs(1500);
    t(n('...only once'), p.sets.length === 2 && p.track === null, JSON.stringify(p.sets));

    p.emit(2);
    p.emit(1);
    await pageMs(1000);
    t(n('paused and played again: the same video is not tried again'), p.sets.length === 2, JSON.stringify(p.sets));

    // Another video in the same player, on the watch page.
    p.videoId = VIDEO2;
    p.tracklist = [huAsr];
    p.emit(3);
    p.emit(1);
    await pageMs(1250);
    t(n('another video: its own try, the ASR track when that is all there is'),
      p.sets.length === 3 && p.sets[2] === huAsr, JSON.stringify(p.sets));
    t(n('turning on: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  // The TV app turns its own start-up subtitles off 1 s after the start: the
  // track is turned on after that, so it does not show, go off and come back.
  {
    const order = [];
    const env = await boot(AUTO, {
      tracklist: [huHuman],
      appDecision: (pl) => { order.push('app off'); pl.track = {}; }
    });
    const set = env.p.win.document.getElementById(PLAYER_ID).setOption;
    env.win.document.getElementById(PLAYER_ID).setOption = (...a) => { order.push('ours'); return set(...a); };
    env.p.emit(1);
    await pageMs(2500);
    t(n("the app's own start-up subtitles come first, then the track, turned on once"),
      order.join() === 'app off,ours' && env.p.sets.length === 1 && env.p.track === huHuman, order.join() + ' ' + JSON.stringify(env.p.sets));
    env.win.close();
  }

  // The player remembers subtitles being on and starts with YouTube's own
  // track: dropped at once (Translated, and Off), not when picked by hand later.
  for (const [mode, then] of [['translated', 'the Hungarian track later'], ['off', 'nothing later']]) {
    const en = { languageCode: 'en', vss_id: '.en' };
    const env = await boot(Object.assign({}, AUTO, { subtitlesAtStart: mode }), { tracklist: [en, huHuman], track: en });
    env.p.emit(1);
    await wait(20);
    const first = JSON.stringify(env.p.sets);
    await pageMs(1500);
    const later = env.p.sets.slice(1);
    dispatchTrusted(env.win.document.body, new env.win.KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
    env.p.track = en; // picked by hand
    env.p.emit(2);
    env.p.emit(1);
    await pageMs(1500);
    t(n(`${mode}: YouTube's own track at the start goes at once, then ${then}`),
      first === '[{}]' && (mode === 'off' ? later.length === 0 : later.length === 1 && later[0] === huHuman), `${first} ${JSON.stringify(later)}`);
    t(n(`${mode}: picked by hand after that: left alone`), env.p.track === en, JSON.stringify(env.p.sets));
    env.win.close();
  }

  // A player that never sends onPlaybackStartExternal: turned on a while after PLAYING.
  {
    const env = await boot(AUTO, { tracklist: [huHuman], noStartEvent: true });
    const emittedAt = Date.now();
    env.p.emit(1);
    await pageMs(3500);
    // Measured in page time from the set itself, so the waits' slack cannot hide a later fallback.
    const after = env.p.setAt.length ? (env.p.setAt[0] - emittedAt) * SPEED : -1;
    t(n('no start event: the track 2.5 s after PLAYING'), env.p.sets.length === 1 && after >= 2500 && after < 2800, `after=${after} sets=${env.p.sets.length}`);
    env.win.close();
  }

  // Next pressed during a video's first second: the next video still gets its
  // subtitles (that key was for the video before).
  {
    const huOther = { languageCode: 'hu', vss_id: '.hu2' };
    const env = await boot(AUTO, { tracklist: [huHuman] });
    env.p.emit(1);
    await pageMs(500);
    dispatchTrusted(env.win.document.body, new env.win.KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
    env.p.videoId = VIDEO2;
    env.p.tracklist = [huOther];
    env.p.emit(3);
    env.p.emit(1);
    await pageMs(2500);
    t(n('Next in the first second: the next video gets its track'), env.p.sets.length === 1 && env.p.sets[0] === huOther, JSON.stringify(env.p.sets));
    env.win.close();
  }

  // Off: the app turns subtitles on a second after the start (YouTube wants
  // them, or they were on earlier in the session): turned off again, unless a
  // key was pressed.
  for (const key of [false, true]) {
    const en = { languageCode: 'en', vss_id: '.en' };
    const env = await boot(Object.assign({}, AUTO, { subtitlesAtStart: 'off' }), { tracklist: [en], appDecision: (pl) => { pl.track = en; } });
    env.p.emit(1);
    if (key) {
      await pageMs(300);
      dispatchTrusted(env.win.document.body, new env.win.KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
    }
    await pageMs(2500);
    t(n(key ? 'Off, a key pressed before the app turns subtitles on: left on' : 'Off: subtitles the app turns on are turned off again'),
      key ? env.p.track === en && env.p.sets.length === 0 : JSON.stringify(env.p.track) === '{}' && env.p.sets.length === 1, JSON.stringify(env.p.sets));
    env.win.close();
  }

  // Translated: the opened video's response starts with the Hungarian track,
  // turned on, so the player puts it on as it loads; YouTube's own default goes
  // from any other response (a tile preview, the video behind "Who's watching").
  {
    const KEY = 'yt-html5-player-modules::subtitlesModuleData::module-enabled';
    const caps = () => ({
      captionTracks: [track('en'), track('hu', { kind: 'asr' })],
      translationLanguages: [tl('en', 'English')],
      audioTracks: [{ captionTrackIndices: [0, 1], defaultCaptionTrackIndex: 0, captionsInitialState: 'CAPTIONS_INITIAL_STATE_ON_RECOMMENDED' }]
    });
    const env = await boot(AUTO);
    env.win.localStorage.setItem(KEY, 'false');
    const opened = env.parse(response(caps())).captions.playerCaptionsTracklistRenderer;
    const at = opened.audioTracks[0];
    t(n('Translated, the opened video: starts with the Hungarian track, turned on'),
      at.defaultCaptionTrackIndex === 1 && at.captionsInitialState === 'CAPTIONS_INITIAL_STATE_ON_REQUIRED', JSON.stringify(at));
    t(n('...and the player told subtitles were on, so it turns that track on as it loads'), env.win.localStorage.getItem(KEY) === 'true');

    env.win.localStorage.setItem(KEY, 'false');
    const other = env.parse(response(caps(), VIDEO2)).captions.playerCaptionsTracklistRenderer.audioTracks[0];
    t(n("Translated, another video (a preview): YouTube's default dropped, subtitles start off"),
      other.defaultCaptionTrackIndex === undefined && other.captionsInitialState === 'CAPTIONS_INITIAL_STATE_OFF_RECOMMENDED' &&
      env.win.localStorage.getItem(KEY) === 'false', JSON.stringify(other));

    env.win.document.body.className = 'WEB_PAGE_TYPE_ACCOUNT_SELECTOR';
    const picker = env.parse(response(caps())).captions.playerCaptionsTracklistRenderer.audioTracks[0];
    t(n("Translated, the video loading behind Who's watching: starts off"),
      picker.defaultCaptionTrackIndex === undefined && picker.captionsInitialState === 'CAPTIONS_INITIAL_STATE_OFF_RECOMMENDED', JSON.stringify(picker));
    env.win.close();
  }
  {
    const env = await boot({ subtitleTranslateLang: 'hu', subtitlesAtStart: 'youtube' });
    const caps = { captionTracks: [track('en'), track('hu')], audioTracks: [{ captionTrackIndices: [0, 1], defaultCaptionTrackIndex: 0 }] };
    const at = env.parse(response(caps)).captions.playerCaptionsTracklistRenderer.audioTracks[0];
    t(n("YouTube's Choice: the response's default is left as it is"), at.defaultCaptionTrackIndex === 0 && at.captionsInitialState === undefined, JSON.stringify(at));
    env.win.close();
  }

  // A Hungarian track already on at the start (the default given in the
  // response, or the player remembering it): kept, the module not loaded again.
  {
    const env = await boot(AUTO, { tracklist: [huAsr, huHuman], track: huHuman });
    env.p.emit(1);
    await pageMs(2500);
    t(n('a Hungarian track on at the start: kept, nothing set, the module not loaded again'),
      env.p.sets.length === 0 && env.p.loads.length === 0 && env.p.track === huHuman, JSON.stringify(env.p.sets) + ' loads=' + env.p.loads.join());
    env.win.close();
  }

  // The app itself turns on a Hungarian track, native or as a translation
  // (YouTube wants subtitles): left alone.
  for (const [label, on] of [['a Hungarian track', huHuman], ['a translation into Hungarian', huTranslated]]) {
    const env = await boot(AUTO, { tracklist: [huAsr, huHuman], appDecision: (pl) => { pl.track = on; } });
    env.p.emit(1);
    await pageMs(2500);
    t(n(`${label} turned on by the app: nothing is set`), env.p.sets.length === 0, JSON.stringify(env.p.sets));
    env.win.close();
  }

  // The tracklist comes a moment later.
  {
    let calls = 0;
    const env = await boot(AUTO, { tracklist: () => (++calls > 3 ? [huHuman] : []) });
    env.p.emit(1);
    await pageMs(2600);
    t(n('a tracklist that comes late: waited for, then the track is turned on'),
      env.p.sets.length === 1 && env.p.sets[0].languageCode === 'hu' && calls >= 4, `calls=${calls} sets=${JSON.stringify(env.p.sets)}`);
    env.win.close();
  }

  // No Hungarian anywhere: asked a few times, then nothing. The response for
  // another video does not count for this one.
  {
    const env = await boot(AUTO, { tracklist: [{ languageCode: 'en', vss_id: '.en' }] });
    env.parse(response({ captionTracks: [track('en')], translationLanguages: [tl('en', 'English')] }, VIDEO2));
    env.p.emit(1);
    await pageMs(4500);
    const asked = env.p.listAsked;
    await pageMs(1000);
    t(n('no track in the language: nothing is set'), env.p.sets.length === 0, JSON.stringify(env.p.sets));
    t(n('...after about ten looks at the tracklist, then no more'), asked >= 8 && asked <= 11 && env.p.listAsked === asked,
      `asked=${asked} later=${env.p.listAsked}`);
    t(n('no track: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }

  // A player whose API lists no tracks: the track the response carried is named.
  {
    const env = await boot(AUTO, { tracklist: [] });
    env.parse(response({ captionTracks: [track('en')], translationLanguages: [tl('en', 'English')] }, VIDEO));
    env.p.emit(1);
    await pageMs(4500);
    const s = env.p.sets[0] || {};
    t(n('no tracklist from the API: the auto-translated track of the response is turned on'),
      env.p.sets.length === 1 && s.languageCode === 'hu' && s.vss_id === '.hu' && s.kind === undefined, JSON.stringify(env.p.sets));
    env.win.close();
  }

  // The setting off, a Shorts page: nothing.
  {
    const env = await boot({ subtitleTranslateLang: 'hu', subtitlesAtStart: 'youtube' }, { tracklist: [huHuman] });
    env.p.emit(1);
    await pageMs(1000);
    t(n('Subtitles at start not Translated: nothing is set'), env.p.sets.length === 0 && env.p.loads.length === 0,
      `sets=${env.p.sets.length} loads=${env.p.loads.join()}`);
    env.win.close();
  }
  {
    const env = await boot(AUTO, { tracklist: [huHuman], page: 'WEB_PAGE_TYPE_SHORTS' });
    env.p.emit(1);
    await pageMs(1000);
    t(n('on Shorts: nothing is set'), env.p.sets.length === 0, JSON.stringify(env.p.sets));
    env.win.close();
  }

  // The viewer presses a key while the tracklist is awaited: their choice wins.
  {
    let ready = false;
    const env = await boot(AUTO, { tracklist: () => (ready ? [huHuman] : []) });
    env.p.emit(1);
    await pageMs(100);
    dispatchTrusted(env.win.document.body, new env.win.KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
    ready = true;
    await pageMs(1500);
    t(n('a key pressed before the tracklist came: nothing is set'), env.p.sets.length === 0, JSON.stringify(env.p.sets));
    env.win.close();
  }

  // The watch page left while the tracklist is awaited.
  {
    let ready = false;
    const env = await boot(AUTO, { tracklist: () => (ready ? [huHuman] : []) });
    env.p.emit(1);
    await pageMs(100);
    env.win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    await wait(20);
    ready = true;
    await pageMs(1500);
    t(n('the watch page left before the tracklist came: nothing is set'), env.p.sets.length === 0, JSON.stringify(env.p.sets));
    env.win.close();
  }

  // The player refuses the track: a warning, no error, no second try.
  {
    const env = await boot(AUTO, { tracklist: [huHuman] });
    env.p.throwOnSet = true;
    env.p.emit(1);
    await pageMs(1500);
    t(n('the player throwing on setOption: tried once, a warning'),
      env.p.sets.length === 1 && env.warnings.some((w) => /Could not turn on subtitles/.test(w)), env.warnings.join(' | '));
    t(n('...and no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }
});
