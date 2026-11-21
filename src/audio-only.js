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
    return !speed || typeof speed.getSpeed !== 'function' || speed.getSpeed() === 1;
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

/** The video playing, loaded again where it is: the next player response decides audio or picture. */
function reloadCurrentVideo() {
  const player = getPlayer();
  if (!player || typeof player.loadVideoById !== 'function') return false;
  try {
    const data = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
    const videoId = data && (data.video_id || data.videoId);
    if (!videoId) return false;
    const at = Math.max(0, Number(player.getCurrentTime && player.getCurrentTime()) || 0);
    // Paused, or cued by the reload before and not played yet.
    const state = typeof player.getPlayerState === 'function' ? player.getPlayerState() : -1;
    const paused = state === 2 || state === 5;
    // The TV player's reload drops the subtitles: put back as the speed reload does.
    const captions = readCaptions(player);
    if (stopKeepingCaptions) stopKeepingCaptions();
    // A paused video is cued, not loaded: it waits at its time with nothing
    // to pause again, and the viewer's Play (YouTube's own control too) just
    // plays it. Measured on a webOS 25 TV: the cued video keeps its time and
    // streams as its new response says. A pause put back after a load lost
    // to that Play, which never reaches the player's playVideo.
    if (paused && typeof player.cueVideoById === 'function') player.cueVideoById({ videoId, startSeconds: at });
    else player.loadVideoById(videoId, at);
    stopKeepingCaptions = captions ? keepCaptions(window, player, captions, () => keyAt, { videoId, keyAt }) : null;
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
    document.documentElement.classList.remove(CLASS);
    // The next video opened loads with its picture.
    streaming = false;
  });
}
