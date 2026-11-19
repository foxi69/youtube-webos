/**
 * SponsorBlock's extras that the settings panel shares with sponsorblock.js:
 * Never Skip on These Channels, and the time saved as text. A module of its
 * own, so ui.js does not load sponsorblock.js ahead of its turn.
 */
import { configRead, configWrite } from './config.js';
import { showNotification } from './notifications.js';
import { SELECTORS } from './utils.js';

/** The channel name of the video in the player, or '' while it is not known. */
export function currentChannelName() {
    try {
        const player = document.getElementById(SELECTORS.PLAYER_ID) || document.querySelector('.html5-video-player');
        const data = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
        return data && typeof data.author === 'string' ? data.author.trim() : '';
    } catch {
        return '';
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
    const name = currentChannelName();
    if (!name) {
        showNotification('No channel to add');
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

