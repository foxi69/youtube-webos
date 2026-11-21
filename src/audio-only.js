/**
 * Audio-Only Mode (the Toggle Audio-Only Mode action).
 *
 * The picture is hidden and the sound plays on, for music and podcasts on an
 * OLED panel: a class on <html> rather than a style on the element, so it
 * survives YouTube replacing the <video> (from jesvijonathan's fork via
 * anikettuli's NicholasBly PR #146). It ends with the watch page, so
 * home-screen previews are not left invisible.
 *
 * With Audio-Only Mode Streams Audio Only (Player) on, the player is also
 * told to play the audio alone: each player response while the mode lasts
 * says playAudioOnly, with the music video type YouTube's TV app gives its
 * audio-only player, and the video playing is loaded again at the same point,
 * so no video stream is downloaded or decoded. Turned off, the video is loaded
 * again with its picture. At a speed other than 1x the picture is only hidden
 * (see atNormalSpeed). From VacuumTube's Music Mode (music-mode/).
 */
import { configRead } from './config.js';
import { showNotification } from './notifications.js';
import { SELECTORS } from './utils.js';
import { readCaptions, keepCaptions } from './speed/player-state.js';

const CLASS = 'ytaf-audio-only';
// The music video type of YouTube's own audio-only playback on TVs.
const AUDIO_ONLY_TYPE = 'MUSIC_VIDEO_TYPE_ATV';

// Asked for: the mode is on with Audio-Only Mode Streams Audio Only.
let streaming = false;

// The viewer's last key press: subtitles they change after a reload are theirs (keepCaptions).
let keyAt = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (evt) => { if (evt.isTrusted !== false) keyAt = Date.now(); }, true);
}
let stopKeepingCaptions = null;

// The TV player plays the sound alone at 1x only: at any other speed it stalls
// silently (measured on webOS 25). A speed change loads the video again, so
// the response of that load decides: above or below 1x the whole video with
// its picture hidden, the sound alone again back at 1x.
function atNormalSpeed() {
  try {
    const speed = typeof window !== 'undefined' && window.ytafSpeed;
    if (speed && typeof speed.getSpeed === 'function' && speed.getSpeed() !== 1) return false;
    // A rate set elsewhere (YouTube's own speed menu, with Playback Speed
    // Control off, gives the app's speed as 1x): the video's own rate.
    const video = document.querySelector('video');
    return !video || !(video.playbackRate > 0) || video.playbackRate === 1;
  } catch {
    return true;
  }
}

/** Whether the player responses are made audio-only now. */
export function streamsAudioOnly() {
  return streaming && atNormalSpeed();
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * A player response (or a watch response with one in it) made audio-only:
 * playerConfig.audioConfig.playAudioOnly, and the music video type. Returns
 * how many responses it changed.
 */
export function makeAudioOnly(data) {
  let changed = 0;
  const holders = [data, data && data.playerResponse];
  for (let i = 0; i < holders.length; i++) {
    const response = holders[i];
    if (!isObject(response) || !isObject(response.streamingData) || !isObject(response.videoDetails)) continue;
    if (i === 1 && response === data) continue;
    if (!isObject(response.playerConfig)) response.playerConfig = {};
    if (!isObject(response.playerConfig.audioConfig)) response.playerConfig.audioConfig = {};
    response.playerConfig.audioConfig.playAudioOnly = true;
    response.videoDetails.musicVideoType = AUDIO_ONLY_TYPE;
    changed++;
  }
  return changed;
}

function getPlayer() {
  return document.getElementById(SELECTORS.PLAYER_ID) || document.querySelector('.html5-video-player');
}

// The keys that always mean play or pause: Play, Pause. OK depends on what has
// the focus: on the Play control it reaches the player's playVideo below.
const PLAYBACK_KEYS = [415, 19];
// Ends the pause a reload still has to put back, or null when none is waiting.
let cancelPause = null;

/** The viewer chose play or pause: a pause still waiting from a reload is dropped. */
export function cancelPendingPause() {
  if (cancelPause) cancelPause();
}

/** A video paused before its reload is paused again, unless the viewer acts first. */
// How long a reloaded video may take to play before its pause is put back anyway.
const PAUSE_FALLBACK_MS = 3000;

function pauseAfterLoad(player, videoId) {
  const onKey = (evt) => {
    if (PLAYBACK_KEYS.indexOf(evt.keyCode) !== -1) cancelPause();
  };
  // A play asked of the player (the pointer on Play, say): a press on anything
  // else leaves the pause to be put back.
  const ownPlay = Object.prototype.hasOwnProperty.call(player, 'playVideo');
  const play = player.playVideo;
  if (typeof play === 'function') {
    player.playVideo = function (...args) {
      if (cancelPause) cancelPause();
      return play.apply(this, args);
    };
  }
  const pauseNow = () => {
    cancelPause();
    try { player.pauseVideo(); } catch { /* gone */ }
  };
  // Put back once the reloaded video plays: a pause asked while it still
  // loads is lost on a slow TV, and it then plays. Its first PLAYING, or the
  // fallback when none comes.
  const onState = ({ detail }) => {
    if (detail && detail.state === 1 && (!detail.videoId || detail.videoId === videoId)) pauseNow();
  };
  const timer = setTimeout(pauseNow, PAUSE_FALLBACK_MS);
  cancelPause = () => {
    clearTimeout(timer);
    window.removeEventListener('yt-player-state-change', onState);
    window.removeEventListener('keydown', onKey, true);
    if (ownPlay) player.playVideo = play;
    else delete player.playVideo;
    cancelPause = null;
  };
  window.addEventListener('yt-player-state-change', onState);
  window.addEventListener('keydown', onKey, true);
}

/** The video playing, loaded again where it is: the next player response decides audio or picture. */
function reloadCurrentVideo() {
  const player = getPlayer();
  if (!player || typeof player.loadVideoById !== 'function') return false;
  try {
    const data = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
    const videoId = data && (data.video_id || data.videoId);
    if (!videoId) return false;
    const at = Math.max(0, Number(player.getCurrentTime && player.getCurrentTime()) || 0);
    // A pause still waiting from the reload before: the video counts as paused.
    const paused = !!cancelPause || (typeof player.getPlayerState === 'function' && player.getPlayerState() === 2);
    if (cancelPause) cancelPause();
    // The TV player's reload drops the subtitles: put back as the speed reload does.
    const captions = readCaptions(player);
    if (stopKeepingCaptions) stopKeepingCaptions();
    player.loadVideoById(videoId, at);
    stopKeepingCaptions = captions ? keepCaptions(window, player, captions, () => keyAt, { videoId, keyAt }) : null;
    if (paused && typeof player.pauseVideo === 'function') pauseAfterLoad(player, videoId);
    return true;
  } catch (e) {
    console.warn('[AudioOnly] Reloading the video failed:', e);
    return false;
  }
}

/** Toggle Audio-Only Mode: on or off, with a notice. */
export function toggleAudioOnly() {
  const on = document.documentElement.classList.toggle(CLASS);
  const before = streamsAudioOnly();
  streaming = on && !!configRead('audioOnlyStream');
  // Above 1x the picture is only hidden: no reload, the stream stays as it is.
  if (streamsAudioOnly() !== before) reloadCurrentVideo();
  showNotification(`Audio-Only Mode ${on ? 'Enabled' : 'Disabled'}`);
  return on;
}

if (typeof window !== 'undefined') {
  window.addEventListener('ytaf-page-update', (e) => {
    if (!e.detail || e.detail.isWatch || e.detail.isShorts) return;
    if (cancelPause) cancelPause();
    document.documentElement.classList.remove(CLASS);
    // The next video opened loads with its picture.
    streaming = false;
  });
}
