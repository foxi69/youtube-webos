import { backupWrite, backupReadAll } from './config-backup.js';

const CONFIG_KEY = 'ytaf-configuration';

export const segmentTypes = {
  sponsor: { color: '#00d400', opacity: '0.7', name: 'sponsored' },
  intro: { color: '#00ffff', opacity: '0.7', name: 'intro' },
  outro: { color: '#0202ed', opacity: '0.7', name: 'outro' },
  interaction: { color: '#cc00ff', opacity: '0.7', name: 'interaction reminder' },
  selfpromo: { color: '#ffff00', opacity: '0.7', name: 'self-promotion' },
  musicofftopic: { color: '#ff9900', opacity: '0.7', name: 'non-music part' },
  preview: { color: '#008fd6', opacity: '0.7', name: 'recap or preview' },
  poi_highlight: { color: '#ff1684', opacity: '0.8', name: 'poi_highlight' },
  filler: { color: '#7300ff', opacity: '0.7', name: 'tangents/jokes' },
  hook: { color: '#395699', opacity: '0.7', name: 'hook/greetings' }
};

/**
 * YouTube ships two wordmarks and swaps between them based on the account's
 * Premium status. Both are the same asset family, so switching is a matter of
 * pointing at the other file and matching its intrinsic width - see
 * logo-style.js.
 */
/** Settings panel themes, in the order the Theme control and the logo cycle them. */
export const uiThemes = {
  fox: 'Fox',
  'blue-force-field': 'Blue',
  'classic-red': 'Red'
};

/**
 * Search: Upload Date - only results uploaded in this window. A filter, not a
 * sort: YouTube no longer sorts by upload date (see hooks/json-stringify.ts).
 */
export const searchUploadDateModes = {
  any: 'Any Time',
  hour: 'Last Hour',
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
  year: 'This Year'
};

/** Search: Duration, Type and Only (hooks/json-stringify.ts). */
export const searchDurationModes = {
  any: 'Any',
  short: 'Under 4 min',
  medium: '4-20 min',
  long: 'Over 20 min'
};
export const searchTypeModes = {
  any: 'Any',
  video: 'Videos',
  channel: 'Channels',
  playlist: 'Playlists',
  movie: 'Movies'
};
export const searchFeatureModes = {
  any: 'Any',
  '4k': '4K',
  hdr: 'HDR',
  live: 'Live',
  subtitles: 'Subtitles'
};

/** What the clock in the corner shows (NicholasBly/youtube-webos#126). */
export const clockModes = {
  off: 'Off',
  time: 'Time',
  datetime: 'Date and Time'
};

// Show Video Quality: a notice when a video starts, the tag under the title, or both.
export const videoQualityDisplayModes = {
  off: 'Off',
  start: 'At Start',
  title: 'Under Title',
  both: 'Both'
};

/** What the time label under the seek bar adds before the duration (NicholasBly/youtube-webos#195). */
export const timeRemainingModes = {
  off: 'Off',
  remaining: 'Remaining',
  end: 'End Time',
  both: 'Both'
};

export const logoStyles = {
  default: 'Default',
  premium: 'Premium',
  hidden: 'Hidden'
};

/**
 * Max Thumbnail Quality: 'off' leaves YouTube's thumbnails as sent; the others
 * are how far above them it reaches.
 *
 * 'safe'    - only ever emit a derivative already known to exist, so a tile can
 *             never land on a 404. Upgrades past that arrive once verified.
 * 'eager'   - go straight to maxresdefault. Sharpest first paint, but videos
 *             with no maxres show a grey box until the correction lands.
 * 'sd'      - 'eager' semantics, but never reaches past sddefault (640x480):
 *             about a quarter of the decode work of maxres per tile, and drawn
 *             from the first frame, so a new tile is never swapped from a lower
 *             rung; the rare video with no sddefault shows a grey box until the
 *             correction lands, and no probe or correction runs while the
 *             remote's arrow keys are moving. The choice for smooth row-to-row
 *             navigation.
 */
export const thumbnailQualityModes = {
  off: 'Off',
  safe: 'Original',
  eager: 'Fast',
  sd: 'Smooth (SD)'
};

export const shortcutActions = {
  none: 'None',
  refresh_page: 'Refresh Page',
  chapter_skip: 'Skip to Next Chapter',
  chapter_skip_prev: 'Skip to Previous Chapter',
  sb_skip_prev: 'Skip to Last SponsorBlock Segment',
  seek_15_fwd: 'Fast Forward (Burst)',
  seek_15_back: 'Rewind (Burst)',
  play_pause: 'Play/Pause',
  toggle_subs: 'Toggle Subtitles',
  toggle_comments: 'Toggle Comments',
  toggle_description: 'Toggle Description',
  save_to_playlist: 'Save / Watch Later',
  oled_toggle: 'Toggle OLED Black Overlay',
  sleep_timer: 'Sleep Timer (15/30/60/90/120 min, off)',
  audio_only: 'Toggle Audio-Only Mode',
  repeat_video: 'Repeat Video (on/off)',
  sb_manual_skip: 'Manual Skip / Jump to Highlight',
  sb_whitelist_channel: 'SponsorBlock: Never Skip on This Channel (on/off)',
  jump_to_live: 'Jump to Live',
  config_menu: 'Open/Close Settings',
  speed_up: 'Playback Speed +',
  speed_down: 'Playback Speed -',
  speed_reset: 'Playback Speed Reset (1x)',
  speed_toggle: 'Toggle Speed (1x / Last)',
  queue_next: 'Play Next in Queue',
  queue_clear: 'Clear Queue',
  long_press_menu: 'Open Long-Press Menu'
};


export const sbModes = {
  auto_skip: 'Auto Skip',
  manual_skip: 'Manual Skip',
  seek_bar: 'Show in Seek Bar',
  disable: 'Disable'
};

export const sbModesHighlight = {
  auto_skip: 'Auto Skip to Start',
  ask: 'Ask when video loads',
  seek_bar: 'Show in Seek Bar',
  disable: 'Disable'
};

/**
 * Video Previews: Default leaves YouTube's own previews setting alone, the
 * others force it off or on (auto-login.js), at once: YouTube reads it as each
 * preview starts. Without sound also mutes them (mute-previews.js).
 */
export const videoPreviewModes = {
  default: 'Default',
  off: 'Off',
  muted: 'Without sound',
  sound: 'With sound'
};


/** The page the app opens on (start-page.js). */
export const startPageModes = {
  home: 'Home',
  subscriptions: 'Subscriptions',
  library: 'Library',
  history: 'History'
};

/**
 * Subtitles When a Video Starts (Player): as YouTube turns them on, off
 * (YouTube's default track dropped from the player response), or the
 * Auto-Translate Subtitles language only (YouTube's default dropped too, while
 * a language is set; where the translation cannot be had, none).
 */
export const subtitlesAtStartModes = {
  youtube: "YouTube's Choice",
  off: 'Off',
  translated: 'Translated'
};

/**
 * AI Videos (Filters): the videos YouTube labels "AI" are shown as they are,
 * marked with a badge, or removed (Remove needs Ad Blocking).
 */
export const aiVideoModes = {
  show: 'Show',
  mark: 'Mark',
  remove: 'Remove'
};

/**
 * Hide Videos Shorter Than, in minutes. The keys are strings, as the panel's
 * cycle rows store them; '0' is off.
 */
export const minVideoLengthModes = {
  0: 'Off',
  1: '1 min',
  2: '2 min',
  3: '3 min',
  5: '5 min',
  10: '10 min',
  20: '20 min'
};

/**
 * Hide Videos Older Than, in days, from the "2 years ago" on the tile
 * (feed-filters.js itemAgeDays). '0' is off.
 */
export const maxVideoAgeModes = {
  0: 'Off',
  7: '1 week',
  30: '1 month',
  90: '3 months',
  180: '6 months',
  365: '1 year',
  730: '2 years'
};

/**
 * Force Max Quality: Off (YouTube picks), Max (the best level the video has)
 * or the best level up to a number of lines (adblock.js drops the formats
 * above it). The keys are not bare numbers, which an object lists first.
 */
export const forceQualityModes = {
  off: 'Off',
  max: 'Max',
  up2160: 'Up to 2160p (4K)',
  up1440: 'Up to 1440p',
  up1080: 'Up to 1080p',
  up720: 'Up to 720p',
  up480: 'Up to 480p'
};

/** The lines a Force Max Quality mode stops at: 0 for Off and Max. */
export function forceQualityLines(mode) {
  const match = /^up(\d+)$/.exec(String(mode));
  return match ? Number(match[1]) : 0;
}

/** Ignore Segments Shorter Than, in seconds ('0': off). */
export const sbMinSegmentLengthModes = {
  0: 'Off',
  1: '1 s',
  2: '2 s',
  3: '3 s',
  5: '5 s',
  10: '10 s'
};

/** Subtitle Position (caption-style.js). */
export const subtitlePositionModes = {
  default: 'Default',
  raised: 'Higher',
  high: 'Highest'
};

/** Left/Right Seek Step, in seconds while the player controls are hidden. '0': YouTube's own. */
export const seekStepModes = {
  0: "YouTube's Default",
  5: '5 s',
  10: '10 s',
  15: '15 s',
  30: '30 s',
  60: '60 s'
};

/**
 * Force Video Codec.
 *
 * 'auto' leaves the player and the server to negotiate, which is what the app
 * has always done. Everything else narrows what the player will accept - see
 * force-codec.js. 'no_av1' is kept separate from 'vp9' because opting out of
 * AV1 (issue #143) should not also cost a set its AVC fallback.
 */
export const videoCodecModes = {
  auto: 'Auto',
  av1: 'AV1',
  vp9: 'VP9',
  avc: 'AVC (H.264)',
  hevc: 'HEVC (H.265)',
  no_av1: 'Avoid AV1'
};

// DeArrow title-cases by default only when the browser is in English, as the extension does.
const isEnglishUI = typeof navigator !== 'undefined' && /^en\b/i.test(navigator.language || '');

/** DeArrow's title formatting, in the extension's order (dearrow/titles.js). */
export const dearrowTitleFormats = {
  disable: 'Disabled',
  title_case: 'Title Case',
  sentence_case: 'Sentence case',
  lower_case: 'lower case',
  first_letter_uppercase: 'First letter uppercase',
  capitalize_words: 'Capitalize Words'
};

/**
 * What DeArrow shows for a video nobody submitted a thumbnail for. 'random', the
 * extension's default, is a frame the DeArrow thumbnail server renders on demand
 * (YouTube's start frame stands in until it has); start, middle and end are
 * YouTube's own auto-generated frames (hq1, hq2, hq3).
 */
export const dearrowThumbnailFallbacks = {
  random: 'Random Frame',
  start: 'Start Frame',
  middle: 'Middle Frame',
  end: 'End Frame',
  original: 'Original',
  blank: 'Blank'
};

const configOptions = new Map([
  ['uiTheme', { default: 'fox', desc: 'UI Theme' }],
  // Set once the Fox theme has been made the default for an existing install,
  // so a later switch back to blue or red sticks. Not shown in the panel.
  ['foxThemeApplied', { default: false, desc: 'Fox theme applied once' }],
  ['enableAdBlock', { default: true, desc: 'Ad Blocking' }],
  ['enableTrackingBlock', { default: false, desc: 'Reduce Telemetry & Tracking' }],
  // Off until switched on: every video opened sends its id to
  // returnyoutubedislikeapi.com, a third party.
  ['enableReturnYouTubeDislike', { default: false, desc: 'Return YouTube Dislike' }],
  ['thumbnailQuality', { default: 'off', desc: 'Max Thumbnail Quality' }],
  ['removeGlobalShorts', { default: false, desc: 'Remove Shorts (Global)' }],
  ['removeLiveVideos', { default: false, desc: 'Remove Live Videos (Global)' }],
  ['removeUpcomingVideos', { default: false, desc: 'Remove Upcoming Videos' }],
  ['removeMembersOnly', { default: false, desc: 'Remove Members-Only Videos' }],
  ['aiVideos', { default: 'show', desc: 'AI Videos' }],
  ['removeTopLiveGames', { default: false, desc: 'Remove Top Live Games' }],
  // YouTube's generated Mix playlists (feed-filters.js isMixItem).
  ['removeMixes', { default: false, desc: 'Remove Mixes' }],
  ['removeMostRelevant', { default: false, desc: 'Remove "Most Relevant" Shelf' }],
  // The rows under a playing video (NicholasBly/youtube-webos#207).
  ['hideRecommendedVideos', { default: false, desc: 'Hide Recommended Videos Under the Player' }],
  // Feed filters (feed-filters.js). Like the filters above, they need Ad Blocking on.
  ['hideWatchedVideos', { default: false, desc: 'Hide Watched Videos' }],
  ['minVideoLength', { default: '0', desc: 'Hide Videos Shorter Than' }],
  ['maxVideoAge', { default: '0', desc: 'Hide Videos Older Than' }],
  ['hideDuplicateVideos', { default: false, desc: 'Hide Repeated Videos' }],
  // Names as YouTube shows them; compared without case.
  ['blockedChannels', { default: [], desc: 'Blocked Channels' }],
  ['blockedKeywords', { default: [], desc: 'Hide Videos Whose Title Contains' }],
  ['enableSponsorBlock', { default: true, desc: 'SponsorBlock' }],
  ['enableMutedSegments', { default: false, desc: 'Allow segments that mute audio' }],
  ['sbPeriodicRefresh', { default: true, desc: 'Periodically Check for New Segments' }],
  ['skipSegmentsOnce', { default: false, desc: 'Skip Segments Once' }],
  ['sbFullVideoLabel', { default: false, desc: 'Show an icon when a video is entirely an advertisement' }],
  ['sbShowTimeWithSkips', { default: false, desc: 'Show time with skips removed' }],
  // Segments shorter than this, in seconds, are not skipped or muted ('0': all are).
  ['sbMinSegmentLength', { default: '0', desc: 'Ignore Segments Shorter Than' }],
  // Channel names, compared without case: nothing is skipped on their videos.
  ['sbWhitelistChannels', { default: [], desc: 'Never Skip on These Channels' }],
  // Off until switched on: a third party learns which segments were skipped.
  ['sbReportSkips', { default: false, desc: 'Count My Skips on SponsorBlock' }],
  // The time skipping saved, in seconds, and the number of skips. Not shown as settings.
  ['sbTimeSaved', { default: 0, desc: 'SponsorBlock time saved' }],
  ['sbSkipCount', { default: 0, desc: 'SponsorBlock skips' }],
  ['sbMode_sponsor', { default: 'auto_skip', desc: 'Sponsor' }],
  ['sbMode_intro', { default: 'auto_skip', desc: 'Intermission/Intro' }],
  ['sbMode_outro', { default: 'auto_skip', desc: 'Endcards/Credits' }],
  ['sbMode_interaction', { default: 'auto_skip', desc: 'Interaction Reminder' }],
  ['sbMode_selfpromo', { default: 'auto_skip', desc: 'Self Promotion' }],
  ['sbMode_musicofftopic', { default: 'auto_skip', desc: 'Non-Music Section' }],
  ['sbMode_preview', { default: 'seek_bar', desc: 'Preview/Recap' }],
  ['sbMode_filler', { default: 'seek_bar', desc: 'Filler/Tangents' }],
  ['sbMode_hook', { default: 'seek_bar', desc: 'Hook/Greetings' }],
  ['sbMode_highlight', { default: 'seek_bar', desc: 'Highlight' }],
  ['hideEndcards', { default: false, desc: 'Hide Endcards' }],
  // ui.js: the comments panel at the end of a watched video, autoplay off only.
  ['openCommentsAtEnd', { default: false, desc: 'Open Comments at the End of a Video' }],
  // The player responses say whether subtitles start on; this says off.
  ['subtitlesAtStart', { default: 'youtube', desc: 'Subtitles When a Video Starts' }],
  // Drops the dubbed audio tracks from the player response, so the original plays.
  ['forceOriginalAudio', { default: false, desc: 'Prefer Original Audio over Dubbed' }],
  // caption-style.js: the subtitles lifted above where YouTube puts them.
  ['subtitlePosition', { default: 'default', desc: 'Subtitle Position' }],
  // caption-style.js: YouTube's own caption style record, kept. Not shown in the panel.
  ['captionStyleBackup', { default: {}, desc: 'Subtitle style kept' }],
  ['seekStep', { default: '0', desc: 'Left/Right Seek Step (Controls Hidden)' }],
  // Remaining time and/or the wall-clock end time beside the duration.
  ['timeRemainingMode', { default: 'off', desc: 'Show Remaining Time / End Time' }],
  // YouTube's "most replayed" curve above the seek bar (most-replayed.js).
  ['showMostReplayed', { default: false, desc: 'Show Most Replayed Graph Above the Seek Bar' }],
  ['enableScrollSeek', { default: false, desc: 'Magic Remote: Scroll Wheel Seeks on Progress Bar' }],
  ['enableAutoLogin', { default: true, desc: 'Bypass Nag Screens' }],
  ['autoSelectAccount', { default: true, desc: 'Auto Login (off: always ask who is watching)' }],
  ['logoStyle', { default: 'default', desc: 'YouTube Logo' }],
  ['clockMode', { default: 'off', desc: 'Clock in UI' }],
  ['clockDuringPlayback', { default: false, desc: 'Keep the Clock On During Playback' }],
  // How long videos have played since the app started, after the time (watch-time.js).
  ['showWatchTime', { default: false, desc: 'Show Watch Time With the Clock' }],
  ['enableOledCareMode', { default: false, desc: 'OLED-Care Mode (True Black UI)' }],
  ['videoShelfOpacity', { default: 100, desc: 'Video shelf opacity' }],
  // Takes YouTube's low-memory class off <body> (app-quality-fix.js).
  ['removeLowMemoryStyle', { default: true, desc: 'Remove Black Text Boxes' }],
  ['keyboardSearch', { default: true, desc: 'Type in Search with a Keyboard' }],
  ['searchUploadDate', { default: 'any', desc: 'Search: Upload Date' }],
  ['searchDuration', { default: 'any', desc: 'Search: Duration' }],
  ['searchType', { default: 'any', desc: 'Search: Type' }],
  ['searchFeature', { default: 'any', desc: 'Search: Only' }],
  ['removeBlackBorders', { default: false, desc: 'New Liquid Glass UI' }],
  ['videoPreviews', { default: 'default', desc: 'Video Previews' }],
  // OK on a playing preview carries it on instead of loading the video again (adblock.js).
  ['continuePreviews', { default: false, desc: 'Open Playing Previews Without Reloading' }],
  // webOS 3-6 only (preview-fix.js, #67).
  ['fixBlackPreviews', { default: true, desc: 'Fix Black Tile Previews' }],
  // About tab (about.js).
  ['checkForUpdates', { default: true, desc: 'Check for Updates' }],
  ['showWhatsNew', { default: true, desc: "Show What's New After an Update" }],
  ['fitPageBesideGuide', { default: false, desc: 'Fit Page Beside Open Menu' }],
  // Left menu entries taken out, by browse id (sidebar.js).
  ['hiddenSidebarEntries', { default: [], desc: 'Hidden Left Menu Entries' }],
  // webOS 3-4 only (emoji-font.js, adblock.js). No switch in the panel: on
  // by default, and nothing is gained by turning it off.
  ['enableLegacyEmojiFix', { default: true, desc: 'Emoji + Characters Fix' }],
  ['hideGuestSignInPrompts', { default: false, desc: 'Guest Mode: Hide Sign-in Buttons' }],
  // forceQualityModes: Off, Max or the best level up to a number of lines.
  ['forceQuality', { default: 'off', desc: 'Force Max Quality' }],
  // Drops the formats YouTube upscaled with AI from player responses (adblock.js).
  ['removeUpscaledFormats', { default: true, desc: 'Skip AI-Upscaled Qualities' }],
  ['showVideoQuality', { default: 'off', desc: 'Show Video Quality' }],
  ['forceVideoCodec', { default: 'auto', desc: 'Force Video Codec' }],
  ['subtitleTranslateLang', { default: 'off', desc: 'Auto-Translate Subtitles' }],
  ['enablePlaybackSpeed', { default: true, desc: 'Playback Speed Control' }],
  // playback-speed.js: the speed of the last run, set again at the start.
  ['rememberPlaybackSpeed', { default: false, desc: 'Remember Playback Speed' }],
  // The last speed set, and the last one other than 1x (Toggle Speed). Not shown in the panel.
  ['savedPlaybackSpeed', { default: 1, desc: 'Last playback speed' }],
  ['toggleSpeed', { default: 1.5, desc: 'Speed for Toggle Speed' }],
  ['blockWebosCast', { default: true, desc: 'Block webOS Cast Service (webOS 25)' }],
  ['disableNotifications', { default: false, desc: 'Disable Notifications' }],
  // A fox button in the top-right corner that the Magic Remote pointer can
  // click to open the panel: for remotes with no colour buttons (#189).
  ['pointerSettingsButton', { default: true, desc: 'Settings Button for the Pointer' }],
  ['disableAnimations', { default: false, desc: 'Disable Animations' }],
  // YouTube closes the app 20 minutes after a pause (screensaver-fix.js).
  ['keepAppOpenWhenPaused', { default: false, desc: 'Keep App Open When Paused' }],
  // Percent, 40-100 in steps of 10: dims the browse UI, never the video.
  ['uiBrightness', { default: 100, desc: 'UI Brightness' }],
  // Each YouTube account on the TV keeps its own settings - see the
  // per-account profile code below.
  ['perAccountSettings', { default: false, desc: 'Separate Settings for Each Account' }],
  ['startPage', { default: 'home', desc: 'Start Page' }],
  // "Not interested", "Don't recommend channel" and "Block channel" in the
  // long-press menu of a video (long-press-menu.js).
  ['extendLongPressMenu', { default: false, desc: 'More Options in the Long-Press Menu' }],
  // DeArrow (dearrow/): crowdsourced titles and thumbnails, from
  // NicholasBly/youtube-webos#200. Off until switched on: like Return YouTube
  // Dislike, it asks a third party (sponsor.ajay.app) - by hash prefix, as
  // SponsorBlock does; a video's frames name it to dearrow-thumb.ajay.app.
  ['enableDeArrow', { default: false, desc: 'DeArrow' }],
  ['dearrowShowBadge', { default: true, desc: 'Show the DeArrow Logo on Crowdsourced Titles/Thumbnails' }],
  ['dearrowCrowdTitles', { default: true, desc: 'Crowdsourced Titles' }],
  // Every title shown, crowdsourced or YouTube's own (the legacy build: Title Case alone).
  ['dearrowTitleFormatting', { default: isEnglishUI ? 'title_case' : 'disable', desc: 'Title Formatting' }],
  ['dearrowCleanEmojis', { default: true, desc: 'Remove Emojis and Fancy Text' }],
  ['dearrowCrowdThumbnails', { default: true, desc: 'Crowdsourced Thumbnails' }],
  ['dearrowThumbnailFallback', { default: 'random', desc: 'Without a Crowdsourced Thumbnail' }]
]);

// Register shortcut keys 0-9
for (let i = 0; i < 10; i++) {
  configOptions.set(`shortcut_key_${i}`, { default: i === 5 ? 'chapter_skip' : 'none', desc: `Key ${i} Action` });
}

// Register shortcut keys Red, Green, Yellow, Blue. Yellow defaults to 'none' so
// YouTube's own binding for it (search) keeps working until it is claimed.
['red', 'green', 'yellow', 'blue'].forEach(color => {
    let def = 'none';
    if (color === 'red') def = 'oled_toggle';
    if (color === 'green') def = 'config_menu';
    if (color === 'blue') def = 'sb_manual_skip';
    configOptions.set(`shortcut_key_${color}`, { default: def, desc: `${color.charAt(0).toUpperCase() + color.slice(1)} Button Action` });
});

for (const [key, value] of Object.entries(segmentTypes)) {
  configOptions.set(`${key}Color`, { default: value.color, desc: `Color for ${value.name}` });
}

const defaultConfig = {};
for (const [k, v] of configOptions) { defaultConfig[k] = v.default; }

const changeListeners = new Map();

/*
 * Per-account settings.
 *
 * With `perAccountSettings` off everything lives in CONFIG_KEY, shared by every
 * account, as it always has. With it on, the settings that belong to a person
 * (ad filters, SponsorBlock, theme, button mapping...) are kept per account in
 * `CONFIG_KEY::<profile>`, while the ones that belong to the TV stay in
 * CONFIG_KEY: those that run before an account is chosen (auto login), and the
 * ones about the hardware (codec, emoji fix, cast block...).
 *
 * The account is read from the leanback client's own identity record. The
 * profile name is a hash of that record's id-like fields, so no account id is
 * stored; tokens and timestamps are skipped, they change while the account
 * stays the same. Guest mode gets a profile of its own that is never stored:
 * each guest session starts from the shared settings, like a new account, and
 * what it changes lasts until it ends (the device settings are still kept).
 */
const DEVICE_KEYS = new Set([
  'perAccountSettings',
  'foxThemeApplied',
  'enableAutoLogin',
  'autoSelectAccount',
  'blockWebosCast',
  'forceVideoCodec',
  'enableLegacyEmojiFix',
  'pointerSettingsButton',
  'keyboardSearch',
  'disableAnimations',
  'keepAppOpenWhenPaused',
  // YouTube keeps its caption style once for the TV, not per account.
  'captionStyleBackup',
  // Read when the app starts, before "Who's watching" picks an account.
  'startPage'
]);
const IDENTITY_KEY = 'yt.leanback.default::last-identity-used';
// Ids first; names and e-mail only when the record has no id, as a rename
// would otherwise move the account to a fresh profile.
const ID_FIELD_RE = /id$/i;
const FALLBACK_FIELD_RE = /(?:user|email|name)$/i;
// Anything that changes while the account stays the same would leave the
// account's settings behind at the next change.
const VOLATILE_FIELD_RE = /token|expir|time|date|secret|index|session|request|nonce|state/i;

/** A stored JSON object, or null: none, not an object, or storage that cannot be read (SecurityError). */
function loadStored(key) {
  try {
    const storage = window.localStorage.getItem(key);
    if (storage === null) return null;
    const parsed = JSON.parse(storage);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function collectIdFields(obj, fieldRe, prefix, out, depth) {
  for (const key of Object.keys(obj)) {
    if (VOLATILE_FIELD_RE.test(key)) continue;
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (depth < 1) collectIdFields(value, fieldRe, prefix + key + '.', out, depth + 1);
    } else if (((typeof value === 'string' && value) || typeof value === 'number') && fieldRe.test(key)) {
      out.push(prefix + key + '=' + value);
    }
  }
}

// Two 32-bit FNV-1a passes with different offsets: a short, stable name that
// does not carry the account id itself.
function hashString(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 15);
  }
  return ('0000000' + (h1 >>> 0).toString(16)).slice(-8) + ('0000000' + (h2 >>> 0).toString(16)).slice(-8);
}

// When the last lookup could not tell the account, the identity record's
// field names (never the values), for the settings panel to show.
let unknownIdentityFields = [];

function readAccountProfile() {
  let data;
  try { data = (loadStored(IDENTITY_KEY) || {}).data; } catch { data = null; }
  unknownIdentityFields = [];
  if (!data || typeof data !== 'object') return null;
  if (String(data.identityType || '').indexOf('GUEST') !== -1) return 'guest';
  const parts = [];
  collectIdFields(data, ID_FIELD_RE, '', parts, 0);
  if (!parts.length) collectIdFields(data, FALLBACK_FIELD_RE, '', parts, 0);
  if (!parts.length) {
    unknownIdentityFields = Object.keys(data);
    return null;
  }
  parts.sort();
  return hashString(parts.join('|'));
}

const profileStorageKey = (profile) => CONFIG_KEY + '::' + profile;
// The guest's settings are not kept (see above).
const GUEST_PROFILE = 'guest';
const storesProfile = (profile) => !!profile && profile !== GUEST_PROFILE;
// What builds before this one stored for the guest goes.
try { window.localStorage.removeItem(profileStorageKey(GUEST_PROFILE)); } catch { /* no storage */ }

function pickAccountValues(source) {
  const out = {};
  for (const key of Object.keys(source)) {
    if (!DEVICE_KEYS.has(key) && configOptions.has(key)) out[key] = source[key];
  }
  return out;
}

// MUTATE IN PLACE ONLY — adblock.js (and other modules) hold a module-level
// reference to this object via the configGetAll() snapshot. Reassigning
// localConfig (e.g. for a future "reset to defaults") would silently desync
// those holders. Use Object.assign(localConfig, defaultConfig) to reset.
// sharedConfig is what CONFIG_KEY holds: everything with per-account settings
// off, and the device settings plus the shared profile with them on.
const sharedConfigStored = loadStored(CONFIG_KEY);
const sharedConfig = sharedConfigStored || {};
// The account profile in use, or null while the shared settings are.
let activeProfile = null;
let profileSeeded = false;
let localConfig = Object.assign({}, defaultConfig, sharedConfig);

if (sharedConfig.perAccountSettings) {
  activeProfile = readAccountProfile();
  if (storesProfile(activeProfile)) {
    const stored = loadStored(profileStorageKey(activeProfile));
    // A new account starts from the shared settings, not from the defaults.
    if (stored) Object.assign(localConfig, pickAccountValues(stored));
    else profileSeeded = true;
  }
}

// Debounce localStorage writes — rapid input (e.g. color picker drag) was
// stringifying the entire ~50-key config object on every event.
let pendingWriteTimer = null;
function writeNow() {
  pendingWriteTimer = null;
  const written = [];
  try {
    if (activeProfile) {
      for (const key of DEVICE_KEYS) sharedConfig[key] = localConfig[key];
      const shared = JSON.stringify(sharedConfig);
      window.localStorage[CONFIG_KEY] = shared;
      written.push([CONFIG_KEY, shared]);
      if (storesProfile(activeProfile)) {
        const own = JSON.stringify(pickAccountValues(localConfig));
        window.localStorage[profileStorageKey(activeProfile)] = own;
        written.push([profileStorageKey(activeProfile), own]);
      }
    } else {
      Object.assign(sharedConfig, localConfig);
      const shared = JSON.stringify(localConfig);
      window.localStorage[CONFIG_KEY] = shared;
      written.push([CONFIG_KEY, shared]);
    }
  }
  catch { /* quota / SecurityError on private mode */ }
  copyToBackup(written);
}

/*
 * The copy of the settings in IndexedDB (config-backup.js), for when YouTube
 * TV empties localStorage. Each write is copied there. An app that starts with
 * no settings in localStorage reads the copy first, and copies nothing until
 * then: the defaults it starts with would replace the copy it is about to read.
 */
// Set in localStorage while the copy has not been read back: a run whose read
// failed leaves it, so the next start tries again instead of taking the
// settings that run stored (its defaults) for the real ones and copying them
// over the copy.
const RECOVERING_KEY = 'ytaf-settings-recovering';
let recovering = false;
try { recovering = window.localStorage.getItem(RECOVERING_KEY) === '1'; } catch { /* no storage */ }
let backupChecked = !!sharedConfigStored && !recovering;
// A write made before the copy was read: copied once it has been.
let backupMissed = false;
function copyToBackup(written) {
  if (!written.length) return;
  if (!backupChecked) { backupMissed = true; return; }
  backupWrite(written).catch(() => { /* best effort */ });
}

const flushPendingWrite = () => {
  if (pendingWriteTimer !== null) { clearTimeout(pendingWriteTimer); writeNow(); }
};
const scheduleWrite = () => {
  if (pendingWriteTimer === null) pendingWriteTimer = setTimeout(writeNow, 200);
};
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushPendingWrite);
  window.addEventListener('pagehide', flushPendingWrite);
  // The TV can suspend a hidden app without either of those: a change made
  // just before it went to the background is written now.
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushPendingWrite(); });
}
if (profileSeeded) scheduleWrite();

/** Writes a change still waiting now (a module that changes a setting as the app goes to the background). */
export function configFlush() {
  flushPendingWrite();
}

function configExists(key) { return configOptions.has(key); }

export function configGetDesc(key) {
  if (!configExists(key)) throw new Error('tried to get desc for unknown config key: ' + key);
  return configOptions.get(key).desc;
}

export function configRead(key) {
  if (!configExists(key)) throw new Error('tried to read unknown config key: ' + key);
  return localConfig[key];
}

// Gate the per-write log behind a flag — configWrite fires per event during
// color-picker drags / opacity-slider scrubs (the localStorage write itself is
// already debounced).
const DEBUG = false;

export function configWrite(key, value) {
  if (!configExists(key)) throw new Error('tried to write unknown config key: ' + key);
  const oldValue = localConfig[key];
  if (oldValue === value) return;

  DEBUG && console.info('Changing key', key, 'from', oldValue, 'to', value);
  localConfig[key] = value;
  scheduleWrite();
  notifyChange(key, value, oldValue);
}

// Left alone by a reset: where the settings are kept (a reset must not merge
// or drop the accounts' profiles), and the records that are not settings
// (a flag, YouTube's own caption style, SponsorBlock's time saved).
const RESET_KEEPS = new Set(['perAccountSettings', 'foxThemeApplied', 'captionStyleBackup', 'sbTimeSaved', 'sbSkipCount']);

/**
 * Every setting back to its default, told to its listeners as if changed in
 * the panel. With separate settings for each account: this account's, and the
 * device settings (DEVICE_KEYS), which all of them share.
 */
export function configResetAll() {
  for (const [key, option] of configOptions) {
    if (RESET_KEEPS.has(key)) continue;
    configWrite(key, Array.isArray(option.default) ? option.default.slice() : option.default);
  }
}

function notifyChange(key, newValue, oldValue) {
  const listeners = changeListeners.get(key);
  if (listeners) {
    const syntheticEvent = { detail: { key, newValue, oldValue } };
    for (const callback of listeners) {
      try { callback(syntheticEvent); }
      catch (err) { console.warn('[Config] change listener failed for', key, err); }
    }
  }
}

/**
 * Loads `profile`'s settings (null: the shared ones) in place of the current
 * account's, telling every listener of a value that changed - the same as if
 * each had been changed in the panel. The outgoing account's pending write is
 * flushed to its own profile first.
 */
// The records restoreFromBackup took from the copy, kept for the session: a
// profile localStorage refused to take back (quota) is loaded from here, for
// the account in use and for one switched to later. Without it that account
// was seeded afresh, and the smaller record, written, replaced its copy.
let restoredRecords = null;

function switchProfile(profile) {
  if (profile === activeProfile) return;
  flushPendingWrite();
  const previous = activeProfile;
  activeProfile = profile;

  let incoming = null;
  if (storesProfile(profile)) {
    // Restored from the backup copy: its record, also when localStorage
    // refused to take it back (quota), so the account is not seeded afresh.
    incoming = loadStored(profileStorageKey(profile)) || (restoredRecords && restoredRecords[profileStorageKey(profile)]) || null;
  }
  if (!incoming) {
    // An account seen for the first time (and every guest session) starts
    // from the shared settings.
    incoming = pickAccountValues(Object.assign({}, defaultConfig, sharedConfig));
    if (storesProfile(profile)) scheduleWrite();
  }
  incoming = pickAccountValues(Object.assign(pickAccountValues(defaultConfig), incoming));

  console.info('[Config] Settings profile:', previous || 'shared', '->', profile || 'shared');
  for (const key of Object.keys(incoming)) {
    const oldValue = localConfig[key];
    const newValue = incoming[key];
    if (oldValue === newValue) continue;
    localConfig[key] = newValue;
    notifyChange(key, newValue, oldValue);
  }
  window.dispatchEvent(new CustomEvent('ytaf-profile-change'));
}

/**
 * Where the current settings come from, for the panel: 'off' (one set for
 * every account), 'account', 'guest', or 'unknown' when per-account settings
 * are on but no account could be told from the identity record. `fields` lists
 * that record's field names in the 'unknown' case, so it can be reported.
 */
export function configGetProfileStatus() {
  if (!localConfig.perAccountSettings) return { state: 'off', fields: [] };
  if (activeProfile === 'guest') return { state: 'guest', fields: [] };
  if (activeProfile) return { state: 'account', fields: [] };
  return { state: 'unknown', fields: unknownIdentityFields.slice() };
}

function checkAccountChange() {
  if (!localConfig.perAccountSettings) return;
  const profile = readAccountProfile();
  // No readable identity (e.g. mid sign-out): keep what is loaded.
  if (profile === null) return;
  switchProfile(profile);
}

// Set while restoreFromBackup applies the copy, which loads the profile itself.
let restoringBackup = false;

configAddChangeListener('perAccountSettings', ({ detail }) => {
  if (restoringBackup) return;
  if (detail.newValue) {
    // The account carries on with exactly the settings it has now.
    activeProfile = readAccountProfile();
    if (!activeProfile) {
      const fields = unknownIdentityFields;
      console.warn('[Config] Per-account settings: no account found in the identity record' +
        (fields.length ? ' (fields: ' + fields.join(', ') + ')' : ''));
    }
  } else {
    // The settings in use become the shared ones, so nothing visibly changes.
    activeProfile = null;
  }
  scheduleWrite();
});

// The account is chosen on the account selector, so it is looked up again
// when the selector is left. The identity record may be written a moment after
// the page has moved on, hence the two later looks.
if (typeof window !== 'undefined') {
  let onSelector = false;
  let recheckTimers = [];
  window.addEventListener('ytaf-page-update', (evt) => {
    const wasOnSelector = onSelector;
    onSelector = !!(evt.detail && evt.detail.isAccountSelector);
    if (onSelector || !wasOnSelector || !localConfig.perAccountSettings) return;
    for (const timer of recheckTimers) clearTimeout(timer);
    checkAccountChange();
    recheckTimers = [setTimeout(checkAccountChange, 1500), setTimeout(checkAccountChange, 5000)];
  });
}

/**
 * Started with no settings in localStorage: the copy in IndexedDB, if there is
 * one, is written back to localStorage and its values take the place of the
 * defaults, told to every listener as if changed in the panel. The settings of
 * each account go back too, and the account in use gets its own. A setting read
 * only once at start (a codec, say) takes the restored value from the next
 * start.
 */
function restoreFromBackup() {
  backupReadAll(CONFIG_KEY).then((entries) => {
    const records = {};
    for (const [key, text] of entries) {
      try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object') records[key] = value;
      } catch { /* not a settings record */ }
    }
    const shared = records[CONFIG_KEY];
    if (!shared) return false;
    restoredRecords = records;
    // What the app wrote meanwhile (foxThemeApplied, say) was the defaults'
    // and is replaced. One record at a time: one too big for the quota does
    // not keep the others out.
    for (const [key, text] of entries) {
      try { window.localStorage.setItem(key, text); } catch { /* applied from memory below */ }
    }
    console.info('[Config] Settings restored from the backup copy:', entries.length, 'record(s)');
    // The account's profile is loaded below, once the shared values are in:
    // the perAccountSettings listener, told of the change, would make it the
    // active one with the shared values and write those over it.
    restoringBackup = true;
    try {
      for (const key of Object.keys(shared)) {
        if (!configOptions.has(key)) continue;
        sharedConfig[key] = shared[key];
        const oldValue = localConfig[key];
        if (oldValue === shared[key]) continue;
        localConfig[key] = shared[key];
        notifyChange(key, shared[key], oldValue);
      }
    } finally {
      restoringBackup = false;
    }
    activeProfile = null;
    if (localConfig.perAccountSettings) {
      const profile = readAccountProfile();
      if (profile !== null) switchProfile(profile);
    }
    return true;
  }).then((restored) => {
    try { window.localStorage.removeItem(RECOVERING_KEY); } catch { /* no storage */ }
    backupChecked = true;
    // No copy, while localStorage has settings (a run after a failed read
    // whose copy turned out empty): those are copied.
    if (!restored && sharedConfigStored) copyStoredToBackup();
    // Copied only if something was written meanwhile: with nothing changed
    // there is nothing to keep.
    if (backupMissed) scheduleWrite();
  }, () => {
    // The copy could not be read: it is left as it is, nothing is copied over
    // it this run, and the next start reads it again (RECOVERING_KEY stays).
  });
}
/**
 * Settings that were in localStorage at the start are copied as they are, a
 * little after the start, so the copy is there before anything is changed
 * (settings stored by a version without the copy included).
 */
const BACKUP_COPY_DELAY_MS = 1500;
function copyStoredToBackup() {
  const entries = [];
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === CONFIG_KEY || (key && key.indexOf(CONFIG_KEY + '::') === 0)) entries.push([key, storage.getItem(key)]);
    }
  } catch { return; }
  copyToBackup(entries);
}
if (typeof window !== 'undefined') {
  if (sharedConfigStored && !recovering) {
    setTimeout(copyStoredToBackup, BACKUP_COPY_DELAY_MS);
  } else {
    try { window.localStorage.setItem(RECOVERING_KEY, '1'); } catch { /* no storage */ }
    restoreFromBackup();
  }
}

export function configAddChangeListener(key, callback) {
  if (!configExists(key)) return;
  if (!changeListeners.has(key)) changeListeners.set(key, new Set());
  changeListeners.get(key).add(callback);
}

export function configRemoveChangeListener(key, callback) {
  if (changeListeners.has(key)) changeListeners.get(key).delete(callback);
}

export function configGetDefault(key) {
  if (!configExists(key)) throw new Error('tried to get default for unknown config key: ' + key);
  return configOptions.get(key).default;
}

// Export the live object reference directly for zero-overhead caching
export function configGetAll() {
  return localConfig;
}
