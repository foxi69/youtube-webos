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
        getVideoData: () => ({ video_id: 'aaaaaaaaaaa' }),
        getCurrentTime: () => 42.5,
        getPlayerState: () => 1,
        loadVideoById: (id, at) => loads.push(id + '@' + at)
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
  return Object.assign(page, { loads, parse, press, on });
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
    const env = boot({ audioOnlyStream: false });
    await wait(100);
    await env.press();
    t('without streaming: the picture is hidden, nothing is loaded again, responses as they are',
      env.on() && env.loads.length === 0 && untouched(env.parse(response())), env.loads.join());
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
    // A paused video stays paused through the reload, unless the viewer plays it first.
    const paused = async (label, later, cfg = {}) => {
      const env = boot(Object.assign({ audioOnlyStream: true }, cfg));
      await wait(100);
      env.win.document.querySelector('video').play = () => Promise.resolve();
      const player = env.win.document.getElementById('ytlr-player__player-container-player');
      let pauses = 0;
      let plays = 0;
      player.getPlayerState = () => 2;
      player.pauseVideo = () => { pauses++; };
      player.playVideo = () => { plays++; };
      const ownPlay = player.playVideo;
      trustedKey(env.win, KEY_7);
      trustedKey(env.win, KEY_7, env.win.document.body, 'keyup');
      t(`paused (${label}): precondition: loaded again`, env.loads.length === 1, env.loads.join());
      if (later) later(env.win, player);
      await wait(200);
      t(`paused (${label}): the player's play is its own again`, player.playVideo === ownPlay);
      return { pauses, plays };
    };
    const kept = await paused('no action');
    t('paused: with no later action the pause is put back', kept.pauses === 1, String(kept.pauses));
    const resumed = await paused('Play key', (win) => trustedKey(win, 415));
    t('paused: Play pressed before it is put back wins', resumed.pauses === 0, String(resumed.pauses));
    const pointer = await paused('play asked of the player', (win, player) => player.playVideo());
    t('paused: a play asked of the player wins, and reaches it', pointer.pauses === 0 && pointer.plays === 1,
      `${pointer.pauses} ${pointer.plays}`);
    const unrelated = await paused('unrelated pointer press', (win) => {
      win.document.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    });
    t('paused: a pointer press on something else leaves the pause to be put back', unrelated.pauses === 1, String(unrelated.pauses));
    const otherOk = await paused('OK on another control', (win) => trustedKey(win, 13));
    t('paused: OK on something else leaves the pause to be put back', otherOk.pauses === 1, String(otherOk.pauses));
    const shortcut = await paused('Play/Pause shortcut', (win) => {
      trustedKey(win, 56);
      trustedKey(win, 56, win.document.body, 'keyup');
    }, { shortcut_key_8: 'play_pause' });
    t('paused: the Play/Pause shortcut wins', shortcut.pauses === 0, String(shortcut.pauses));
  }
});
