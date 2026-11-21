/**
 * SponsorBlock's extras that the settings panel shares with sponsorblock.js:
 * Never Skip on These Channels, and the time saved as text. A module of its
 * own, so ui.js does not load sponsorblock.js ahead of its turn.
 */
import { configRead, configWrite } from './config.js';
import { showNotification } from './notifications.js';
import { SELECTORS } from './utils.js';

/**
 * The channel name of the video in the player, or '' while it is not known.
 * With `videoID`: also '' while the player still reports another video (the
 * one before, as the next loads). Data without a video ID is taken as it is.
 * webOS 25 leaves the author empty: then the title tray names the channel, but
 * only when the player reports `videoID`, as the tray has no video identity.
 */
export function currentChannelName(videoID) {
    try {
        const player = document.getElementById(SELECTORS.PLAYER_ID) || document.querySelector('.html5-video-player');
        const data = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
        if (!data) return '';
        if (videoID && typeof data.video_id === 'string' && data.video_id && data.video_id !== videoID) return '';
        const author = typeof data.author === 'string' ? data.author.trim() : '';
        if (author) return author;
        return videoID && data.video_id === videoID ? titleTrayChannel() : '';
    } catch {
        return '';
    }
}

/** The first item of the title tray's metadata line (the channel), or ''. */
export function titleTrayChannel() {
    const line = document.querySelector('ytlr-video-title-tray ytlr-video-metadata-line yt-formatted-string');
    return line ? line.textContent.trim() : '';
}

/** The video ID in the watch page's address (#/watch?v=ID), or null. */
export function videoIdFromHash() {
    try {
        const hash = window.location.hash;
        if (!hash.startsWith('#')) return null;
        const parts = hash.split('?');
        if (parts.length < 2) return null;
        if (typeof URLSearchParams !== 'undefined') return new URLSearchParams(parts[1]).get('v');
        const match = parts[1].match(/(?:[?&]|^)v=([^&]+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/** Whether `name` is on Never Skip on These Channels (compared without case). */
export function isChannelWhitelisted(name) {
    if (!name) return false;
    const list = configRead('sbWhitelistChannels');
    if (!Array.isArray(list) || !list.length) return false;
    const lower = name.toLowerCase();
    return list.some(entry => typeof entry === 'string' && entry.trim().toLowerCase() === lower);
}

/**
 * SponsorBlock: Never Skip on This Channel (on/off), a shortcut action: the
 * channel of the video playing goes on the list, or off it.
 */
export function toggleChannelWhitelist() {
    // The video being watched: while the player still reports the one before
    // (the next one loading), its channel is not taken for this one's.
    const name = currentChannelName(videoIdFromHash());
    if (!name) {
        showNotification(currentChannelName() ? 'The channel is not known yet: try again in a moment' : 'No channel to add');
        return;
    }
    const list = Array.isArray(configRead('sbWhitelistChannels')) ? configRead('sbWhitelistChannels') : [];
    if (isChannelWhitelisted(name)) {
        const lower = name.toLowerCase();
        configWrite('sbWhitelistChannels', list.filter(entry => typeof entry !== 'string' || entry.trim().toLowerCase() !== lower));
        showNotification(`SponsorBlock skips on ${name} again`);
    } else {
        configWrite('sbWhitelistChannels', list.concat([name]));
        showNotification(`SponsorBlock: nothing skipped on ${name}`);
    }
}

/** "1 h 23 min", "4 min 5 s", "12 s". */
export function formatTimeSaved(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min ${sec} s`;
    return `${sec} s`;
}

