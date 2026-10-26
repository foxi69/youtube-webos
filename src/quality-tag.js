import { configRead, configAddChangeListener } from './config.js';
import { isWatchPage } from './utils.js';
import { playingQualityLabel } from './video-quality.js';
import { cssString } from './sponsorblock-labels.js';
import './quality-tag.css';

/**
 * Show Video Quality Next to the Title: the quality the video plays in
 * ("1080p60", "2160p60 HDR") as a small tag after the metadata line under
 * the title in the player (channel · views · date). Asked for in
 * NicholasBly/youtube-webos#204 (fork watch #51).
 *
 * Like the SponsorBlock readouts (sponsorblock-labels.js), it is a
 * pseudo-element whose content this module writes into one <style>: a node
 * added to YouTube's player chrome would be deleted by incremental-dom, and
 * the rule applies by itself whenever the title tray is rebuilt. The text is
 * rewritten when the player changes state or the picture changes size (the
 * adaptive stream switching quality), so it costs nothing per frame.
 */

const TAG_SELECTOR =
  'ytlr-video-title-tray ytlr-video-metadata-line::after,' +
  'ytlr-watch-metadata ytlr-video-metadata-line::after';

let styleEl = null;
let css = '';

function write(next) {
  if (next === css && (!next || (styleEl && styleEl.isConnected))) return;
  css = next;
  if (!styleEl || !styleEl.isConnected) {
    if (!next) return;
    styleEl = document.createElement('style');
    styleEl.id = 'ytaf-quality-tag';
    (document.head || document.documentElement).appendChild(styleEl);
  }
  styleEl.textContent = next;
}

/** The rule for `label`, or '' for none. */
export function buildTagCss(label) {
  return label ? `${TAG_SELECTOR}{content:${cssString(label)};}` : '';
}

function update() {
  if (!configRead('showQualityInTitle') || !isWatchPage()) {
    write('');
    return;
  }
  write(buildTagCss(playingQualityLabel()));
}

function onResize(evt) {
  if (evt.target instanceof HTMLVideoElement) update();
}

window.addEventListener('yt-player-state-change', update);
window.addEventListener('ytaf-page-update', update);
// A <video> fires 'resize' when its picture size changes; media events do
// not bubble, so it is caught on the way down.
document.addEventListener('resize', onResize, true);
configAddChangeListener('showQualityInTitle', update);
update();
