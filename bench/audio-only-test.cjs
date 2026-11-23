/**
 * Audio-Only Mode (src/audio-only.js): the action hides the picture; with
 * Audio-Only Mode Streams Audio Only on it also makes the player responses
 * audio-only (playAudioOnly, the TV's audio-only music type) and loads the
 * video again where it is, on and off. Leaving the watch page ends it.
 *
 * Usage: node bench/audio-only-test.cjs [bundle] [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, wait } = require('./harness.cjs');

const { t, run } = createReporter();
const KEY_7 = 55;
const pad = 'z'.repeat(600);

function boot(cfg) {
  let NS;
  const loads = [];
  // The video the player reports; null: none for now (between two loads, say).
  const playing = { id: 'aaaaaaaaaaa' };
  const page = bootPage({
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    url: 'https://www.youtube.com/tv#/watch?v=aaaaaaaaaaa',
    inner: '<div id="ytlr-player__player-container-player"><video></video></div>',
    ignoreNavigation: true,
    consoleErrors: false,
    config: Object.assign({
      enableAdBlock: true, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      thumbnailQuality: 'off', enableAutoLogin: false, checkForUpdates: false, showWhatsNew: false,
      shortcut_key_7: 'audio_only'
    }, cfg),
    fetch: 'pending',
    setup: (w) => { NS = w.JSON.stringify; },
    beforeEval: (w) => {
      const player = w.document.getElementById('ytlr-player__player-container-player');
      Object.assign(player, {
        getVideoData: () => (playing.id ? { video_id: playing.id } : {}),
        getCurrentTime: () => 42.5,
        getPlayerState: () => 1,
        loadVideoById: (id, at) => loads.push(id + '@' + at),
        cueVideoById: (opts) => loads.push('cue:' + opts.videoId + '@' + opts.startSeconds)
      });
    }
  });
  const parse = (obj) => page.win.JSON.parse(NS(obj));
  const press = async () => {
    trustedKey(page.win, KEY_7);
    trustedKey(page.win, KEY_7, page.win.document.body, 'keyup');
    await wait(200);
  };
  const on = () => page.win.document.documentElement.classList.contains('ytaf-audio-only');
  const notice = () => (page.win.document.querySelector('.ytaf-notification-container') || {}).textContent || '';
  return Object.assign(page, { loads, parse, press, on, playing, notice });
}

const response = () => ({
  responseContext: { _pad: pad },
  streamingData: { adaptiveFormats: [{ itag: 251, mimeType: 'audio/webm' }] },
  videoDetails: { videoId: 'aaaaaaaaaaa' }
});
const audioOnly = (r) => !!(r.playerConfig && r.playerConfig.audioConfig && r.playerConfig.audioConfig.playAudioOnly === true) &&
  r.videoDetails.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV';
// Neither audio-only edit: one of the two alone is a response changed too.
const untouched = (r) => !(r.playerConfig && r.playerConfig.audioConfig && 'playAudioOnly' in r.playerConfig.audioConfig) &&
  !('musicVideoType' in r.videoDetails);

run(async () => {
  {
    const env = boot({ audioOnlyStream: true });
    await wait(100);
    t('before: a player response is left as it is', untouched(env.parse(response())));
    await env.press();
    t('on: the picture is hidden', env.on());
    t('on: the video is loaded again where it is', env.loads.join() === 'aaaaaaaaaaa@42.5', env.loads.join());
    const r = env.parse(response());
    t('on: player responses are audio-only', audioOnly(r), JSON.stringify(r.playerConfig));
    const wrapped = env.parse({ responseContext: { _pad: pad }, playerResponse: response(), contents: { singleColumnWatchNextResults: {} } });
    t('on: also a player response inside a watch response', audioOnly(wrapped.playerResponse));
    await env.press();
    t('off: the picture comes back, and the video is loaded again with it',
      !env.on() && env.loads.length === 2 && untouched(env.parse(response())), env.loads.join());
    t('no page error', env.errors.length === 0, env.errors[0]);
  }
  {
    // Switched off while the player names no video for a moment: the video
    // cannot be loaded again with its picture now, and the notice says so
    // instead of a plain Disabled.
    const env = boot({ audioOnlyStream: true });
    await wait(100);
    await env.press();
    t('off, no reload: precondition: on, loaded again', env.on() && env.loads.length === 1, env.loads.join());
    env.playing.id = null;
    await env.press();
    t('off, no reload: the notice says the picture comes with the next video',
      !env.on() && env.loads.length === 1 && /next video/.test(env.notice()), env.notice());
  }
  {
    // Subtitles on: the reload drops them (as the TV player's does), and they come back.
    const env = boot({ audioOnlyStream: true });
    await wait(100);
    const player = env.win.document.getElementById('ytlr-player__player-container-player');
    const EN = { languageCode: 'en', languageName: 'English', vssId: '.en' };
    let track = EN;
    const set = [];
    player.getOption = (m, k) => (k === 'track' ? track : []);
    player.setOption = (m, k, v) => { set.push(v); track = v; };
    player.loadModule = () => {};
    const load = player.loadVideoById;
    player.loadVideoById = (id, at) => { load(id, at); track = {}; };
    await env.press();
    t('subtitles: precondition: loaded again', env.loads.length === 1, env.loads.join());
    await wait(1300);
    t('subtitles: the track in use before the reload is put back', set.length >= 1 && set[set.length - 1].languageCode === 'en',
      JSON.stringify(set));
  }
  {
    const env = boot({ audioOnlyStream: false });
    await wait(100);
    await env.press();
    t('without streaming: the picture is hidden, nothing is loaded again, responses as they are',
      env.on() && env.loads.length === 0 && untouched(env.parse(response())), env.loads.join());
  }
  {
    // The TV player stalls on the sound alone at any speed but 1x: there the
    // picture is only hidden, and back at 1x the sound alone again. A speed
    // change loads the video again itself, so the response decides.
    const env = boot({ audioOnlyStream: true });
    await wait(100);
    let speed = 1.5;
    env.win.ytafSpeed = { getSpeed: () => speed };
    await env.press();
    t('at 1.5x: precondition: the picture is hidden', env.on());
    t('at 1.5x: turned on, nothing is loaded again and responses are as they are',
      env.loads.length === 0 && untouched(env.parse(response())), env.loads.join());
    speed = 1;
    t('back at 1x: responses are audio-only again', audioOnly(env.parse(response())));
    speed = 2;
    t('a speed change while on: the load it makes gets the whole video', untouched(env.parse(response())));
    speed = 1;
    await env.press();
    t('off at 1x: the video is loaded again with its picture',
      !env.on() && env.loads.join() === 'aaaaaaaaaaa@42.5' && untouched(env.parse(response())), env.loads.join());
  }
  {
    const env = boot({ audioOnlyStream: true, enableAdBlock: false });
    await wait(100);
    await env.press();
    t('with Ad Blocking off: responses are audio-only too', audioOnly(env.parse(response())));
    // Leaving the watch page ends it: the next video opened has its picture.
    env.win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    env.win.location.hash = '#/';
    await wait(300);
    t('leaving the watch page ends it', !env.on() && untouched(env.parse(response())));
  }
  {
    // A paused video is cued where it is, not loaded: it waits there with no
    // pause to put back, and whatever the viewer then plays it with plays it.
    const env = boot({ audioOnlyStream: true });
    await wait(100);
    const player = env.win.document.getElementById('ytlr-player__player-container-player');
    let state = 2;
    let pauses = 0;
    player.getPlayerState = () => state;
    player.pauseVideo = () => { pauses++; };
    await env.press();
    t('paused: cued where it is, not loaded', env.loads.join() === 'cue:aaaaaaaaaaa@42.5', env.loads.join());
    // Cued and not played yet (state 5): off again, cued again.
    state = 5;
    await env.press();
    t('cued, not played yet: cued again, not loaded', env.loads.join() === 'cue:aaaaaaaaaaa@42.5,cue:aaaaaaaaaaa@42.5', env.loads.join());
    env.win.dispatchEvent(new env.win.CustomEvent('yt-player-state-change', { detail: { state: 1, videoId: 'aaaaaaaaaaa' } }));
    await wait(3200);
    t('paused: nothing paused again, now or later', pauses === 0, String(pauses));
    // Playing: loaded, so it plays on.
    state = 1;
    await env.press();
    t('playing: loaded, not cued', env.loads[2] === 'aaaaaaaaaaa@42.5', env.loads.join());
  }
  {
    // A player with no cueVideoById: a paused video is loaded as before.
    const env = boot({ audioOnlyStream: true });
    await wait(100);
    const player = env.win.document.getElementById('ytlr-player__player-container-player');
    player.getPlayerState = () => 2;
    delete player.cueVideoById;
    await env.press();
    t('paused, no cue in the player: loaded', env.loads.join() === 'aaaaaaaaaaa@42.5', env.loads.join());
  }
});
