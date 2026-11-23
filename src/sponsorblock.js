import sha256 from 'tiny-sha256';
import { configAddChangeListener, configRemoveChangeListener, segmentTypes, configGetAll, configRead, configWrite, configActiveProfile } from './config';
import { showNotification } from './notifications.js';
import sponsorBlockUI from './Sponsorblock-UI.js';
import sponsorBlockLabels, { isFullVideoSegment, shorterThan } from './sponsorblock-labels.js';
import { isLegacyWebOS } from './webos-utils.js';
import { getVideo, rendererChapterStarts } from './utils.js';
import { currentChannelName, isChannelWhitelisted, videoIdFromHash } from './sponsorblock-extras.js';
import { fetchJsonWithTimeout } from './fetch-timeout.js';
import { showSkipButton } from './sponsorblock-skip-button.js';
import './sponsorblock.css';

// The official server first. The community mirror is only asked when the
// official one fails, so the video hash prefixes normally go to one operator.
const SPONSORBLOCK_CONFIG = {
    primaryAPI: 'https://sponsor.ajay.app/api',
    fallbackAPI: 'https://sponsorblock.inf.re/api',
    timeout: 5000,
};

const CONFIG_MAPPING = {
    sponsor: 'sbMode_sponsor',
    intro: 'sbMode_intro',
    outro: 'sbMode_outro',
    interaction: 'sbMode_interaction',
    selfpromo: 'sbMode_selfpromo',
    musicofftopic: 'sbMode_musicofftopic',
    preview: 'sbMode_preview',
    filler: 'sbMode_filler',
    hook: 'sbMode_hook'
};

const EXTRA_CONFIG_KEYS = [
    'enableMutedSegments', 'sbMode_highlight', 'skipSegmentsOnce',
    'sbFullVideoLabel', 'sbShowTimeWithSkips', 'sbMinSegmentLength', 'sbWhitelistChannels',
    // Color keys so the overlay redraws when the user changes a segment color
    ...Object.keys(segmentTypes).map(k => `${k}Color`)
];

const CHAIN_SKIP_CONSTANTS = {
    START_THRESHOLD: 0.5,
    OVERLAP_TOLERANCE: 0.2,
    MIN_PLAYBACK_TIME: 0.1
};

// By the API's names: the settings' 'musicofftopic' is 'music_offtopic' on the
// server. Requesting the settings' spelling silently returned none of them.
// normalizeSegments() maps the answer back to the settings' name.
// exclusive_access is a full-video label only (actionType 'full'): it has no
// mode, so it never reaches the skip, mute or bar paths, but without asking
// for it the "Exclusive Access" badge could never appear.
const FETCH_CATEGORIES = encodeURIComponent(JSON.stringify([
    'sponsor', 'intro', 'outro', 'interaction', 'selfpromo',
    'music_offtopic', 'preview', 'chapter', 'poi_highlight',
    'filler', 'hook', 'exclusive_access'
]));

// Waits before asking again when both servers failed. An empty answer is an
// answer and is never retried.
const FETCH_RETRY_DELAYS = [2000, 4000];

/**
 * Periodic re-check while a video plays ("Periodically Check for New
 * Segments"). Segments are often submitted hours after upload, so a video
 * that had none - or only some - when it opened is asked about again: every
 * 15 minutes while it has segments, and with a 5/10/20/30 minute back-off
 * while it has none or the servers fail. The timer only fetches while the
 * video plays; one that comes due during a pause fetches on resume.
 * From Yasich217's fork.
 */
const MINUTE_MS = 60 * 1000;
// How often marks waiting for the chapter pieces' width look again (_watchChapterMeasure).
const CHAPTER_MEASURE_MS = 1000;
const REFRESH_POPULATED_MS = 15 * MINUTE_MS;
const REFRESH_BACKOFF_MS = [5, 10, 20, 30].map(m => m * MINUTE_MS);

/** Order-independent identity of a segment list, to tell a real change from a re-send. */
function segmentsSignature(segments) {
    return segments
        .map(s => s.UUID || `${s.category}:${s.actionType}:${s.segment[0]}:${s.segment[1]}`)
        .sort()
        .join('|');
}

/**
 * Whether the <video> has the video loaded. On webOS 25 a video YouTube cannot
 * play ("This video isn't available") leaves it with no source: readyState 0
 * and no duration, while the player's own data still says it is playable.
 */
function hasMedia(video) {
    return !!video && !video.error && video.readyState >= 1 && video.duration > 0;
}

function isWellFormedSegment(entry) {
    return !!entry &&
        typeof entry.category === 'string' &&
        Array.isArray(entry.segment) &&
        typeof entry.segment[0] === 'number' &&
        typeof entry.segment[1] === 'number';
}

/** Drops malformed API entries and maps API category names to the settings' names. */
function normalizeSegments(segments) {
    const out = [];
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!isWellFormedSegment(seg)) continue;
        if (seg.category === 'music_offtopic') seg.category = 'musicofftopic';
        out.push(seg);
    }
    return out;
}
/**
 * Full-video labels are always requested.
 *
 * They were originally fetched only when the badge was switched on, to keep the
 * default request identical. That made enabling the option mid-video do
 * nothing: the segment list had already been fetched without them, so there was
 * no label to show until the next video. One extra actionType on a request that
 * happens anyway is a much smaller cost than a setting that silently does not
 * apply.
 */
/*
 * Chapters too: the community's chapters (category and actionType 'chapter',
 * with a name in `description`) come only when asked for by their action type.
 * They are never skipped, muted or drawn; Skip to Next/Previous Chapter uses
 * them on a video with no chapters of its own (communityChapters).
 */
const FETCH_ACTION_TYPES = encodeURIComponent(JSON.stringify(['skip', 'mute', 'full', 'chapter']));

const HAS_ABORT_CONTROLLER = typeof AbortController !== 'undefined';

// An auto skip can be taken back this long after it (handleBlueButton).
const UNDO_WINDOW_MS = 8000;
// Never Skip on These Channels: the channel's name may come a moment after the
// segments; looked for again this often, this many times.
const CHANNEL_RETRY_MS = 1000;
const CHANNEL_RETRIES = 10;

/**
 * Where [start, end] sits on a chaptered bar (see _chapterLayout), as
 * { left, width } percentages of the bar: one range per chapter it touches.
 */
function barRanges(layout, start, end) {
    const ranges = [];
    const { pieces, total } = layout;
    for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        const { from, to } = p;
        const a = Math.max(start, from);
        const b = Math.min(end, to);
        if (a >= b) continue;
        const left = p.x + ((a - from) / (to - from)) * p.width;
        const right = p.x + ((b - from) / (to - from)) * p.width;
        ranges.push({ left: (left / total) * 100, width: ((right - left) / total) * 100 });
    }
    return ranges;
}

/** Where the time `t` sits on a chaptered bar, as a percentage of the bar. */
function barPercentAt(layout, t) {
    const { pieces, total } = layout;
    let i = 0;
    while (i < pieces.length - 1 && t >= pieces[i].to) i++;
    const p = pieces[i];
    const x = p.x + Math.min(1, Math.max(0, (t - p.from) / (p.to - p.from))) * p.width;
    return (x / total) * 100;
}

class SponsorBlockHandler {
    constructor(videoID) {
        this.videoID = videoID;
        this.logPrefix = `[SB:${this.videoID}]`;
        
        this.segments = [];
        this.highlightSegment = null;
        this.video = null;
        this.progressBar = null;
        this.overlay = null;
        this.activeBarSelector = null;
        
        this.debugMode = false;
        
        this.isLegacyWebOSVer = isLegacyWebOS();

        // Tracking state
        this.lastSkipTime = -1;
        this.lastSkippedSegmentIndex = -1;
        this.lastNotifiedSegmentIndex = -1;
        this.hasPerformedChainSkip = false;
        this.skipSegments = [];
        this.muteSegments = [];
        this.refreshTimer = null;
        this.refreshPending = false;
        this.refreshInFlight = false;
        this.consecutiveEmptyChecks = 0;
        this.consecutiveFailures = 0;
        this.mutedSegment = null;
        this.mutedBefore = false;
        this.nextSegmentIndex = 0;
        this.nextSegmentStart = Infinity;

        // Status flags
        this.activeCategories = new Set();
        this.isProcessing = false;
        this.isSkipping = false;
        // Where the last skip of a segment went (for autoJumpToHighlight).
        this.ownSkipTarget = null;
        this._highlightGuard = null;
        this.isDestroyed = false;
        this.skippedSegmentIndices = new Set();
        this.tempWhitelistIndex = -1; // Whitelist segment when using shortcut

        // Manual skip tracking
        this.activeManualNotification = null;
        this.currentManualSegment = null;

        // Listeners & Observers
        this.observers = new Set();
        this.listeners = new Map();
        this.configListeners = [];
        this.rafIds = new Set();

        this.abortController = null;

        // High Frequency Polling
        this.pollingRafId = null;
        this.boundHighFreqLoop = this.highFreqLoop.bind(this);

        this.isTimeListenerActive = false;
        this.boundTimeUpdate = this.handleTimeUpdate.bind(this);

        this.lastOverlayHash = null;

        this._skipWatchdogTimer = null;
        this._videoWait = null;
        this._videoWaitTimer = null;
        // The highlight's auto jump, waiting for a <video> to be bound.
        this.highlightPending = false;
        this._barObserverStarted = false;
        this._attrObserver = null;
        this._chapterObserver = null;
        this._lastSyncSig = null;

        this._observedRoot = null;
        this._barRetryTimer = null;

        // Cached _getProgressBarAnchor() result, keyed on progressBar identity.
        this._anchorCache = null;
        this._anchorCacheBar = null;

        this.setupConfigListeners();

        this.log('info', `Created handler for ${this.videoID}`);
    }

    // ==========================================
    // Progress-bar geometry
    // ==========================================
    //
    // Node#isConnected and Element#closest are guaranteed by polyfills.js,
    // imported via utils.js.

    _getProgressBarAnchor() {
        if (!this.progressBar) return { container: null, asSibling: false };

        // FIX (replay): validate the cached container too, not just the bar
        // identity. The TV UI can reuse the same progress-bar node while
        // rebuilding the wrapper around it, which left us holding a detached
        // ancestor and inserting the overlay into an orphaned subtree —
        // built, inserted, invisible.
        if (this._anchorCache &&
            this._anchorCacheBar === this.progressBar &&
            (!this._anchorCache.container || this._anchorCache.container.isConnected)) {
            return this._anchorCache;
        }

        // ALWAYS inject as a sibling. YouTube's virtual DOM destroys foreign children.
        //
        // These MUST stay as two chained calls. closest('a, b') returns the
        // NEAREST ancestor matching either selector — and ytlr-progress-bar
        // sits inside ytlr-multi-markers-player-bar-renderer, so a union
        // selector would silently invert this priority order and anchor the
        // overlay to the wrong element.
        const ytPB = this.progressBar.closest('ytlr-multi-markers-player-bar-renderer') ||
                     this.progressBar.closest('ytlr-progress-bar') ||
                     this.progressBar;
                     
        const parent = ytPB.parentNode;
        let result;

        if (!parent) {
            result = { container: this.progressBar, asSibling: false };
        } else {
            const ps = window.getComputedStyle(parent);
            if (ps.position === 'static') parent.style.setProperty('position', 'relative', 'important');
            if (ps.display === 'inline' || ps.display === '') {
                parent.style.setProperty('display', 'block', 'important');
            }
            result = { container: ytPB, asSibling: true };
        }

        this._anchorCache = result;
        this._anchorCacheBar = this.progressBar;
        return result;
    }

    // Copies ytlr-progress-bar's offset rect onto the sibling overlay so they
    // occupy exactly the same visual space.
    // Positions the sibling overlay to exactly cover the inner progress track element
    _offsetRelativeTo(el, ancestor) {
        if (!el || !ancestor) return { top: 0, left: 0 };
        // getBoundingClientRect gives the exact pixel coordinates relative to the viewport
        const rectEl = el.getBoundingClientRect();
        const rectAncestor = ancestor.getBoundingClientRect();
        return {
            top: rectEl.top - rectAncestor.top,
            left: rectEl.left - rectAncestor.left
        };
    }

    /**
     * The element holding the bar's chapter pieces: on a chaptered video
     * YouTube draws one child per chapter (idomkey chapter-N), with a margin
     * between them, beside the tracked segment element.
     */
    _chapterTrack() {
        const bar = this.progressBar;
        if (!bar) return null;
        // Under the bar (at any depth, the renderer tracked itself): the
        // pieces' own parent; else beside the bar. Any piece, not chapter-0
        // alone: a first chapter left out may leave no chapter-0.
        const keyed = bar.querySelectorAll('[idomkey^="chapter-"]');
        for (let i = 0; i < keyed.length; i++) {
            if (/^chapter-\d+$/.test(keyed[i].getAttribute('idomkey'))) return keyed[i].parentNode;
        }
        return bar.parentNode;
    }

    _chapterElements() {
        const track = this._chapterTrack();
        const out = [];
        if (!track || !track.children) return out;
        for (let i = 0; i < track.children.length; i++) {
            const el = track.children[i];
            if (/^chapter-\d+$/.test(el.getAttribute('idomkey') || '')) out.push(el);
        }
        return out;
    }

    /**
     * A cheap signature of the chapter pieces (no layout read): their width,
     * inline margins and class (the gaps of YouTube's CSS), and the start
     * times the renderer has; a change redraws the marks. Only these of the
     * inline style, so a style written on every frame does not.
     */
    _chapterSig() {
        const els = this._chapterElements();
        // The chapters drawn too: the renderer can leave out another one with
        // the same pieces in the DOM, and the pieces then mean other chapters.
        let sig = rendererChapterStarts().join(',') + '|' + rendererChapterStarts(true).join(',') + '|';
        for (let i = 0; i < els.length; i++) {
            const st = els[i].style;
            sig += els[i].className + ':' + st.width + ':' + st.marginLeft + ':' + st.marginRight + ',';
        }
        return sig;
    }

    /**
     * The chapter pieces as laid out: each one's x and width in the bar, and
     * the times it spans. The times are the renderer's chapter start times;
     * without them, the pieces' widths share out the duration. The bar leaves
     * out a chapter too short to draw (the 7 s introduction of a 2-hour video,
     * read on the TV), which the renderer gives a width of 0: the pieces are
     * the other chapters, and a left-out one's time goes to the piece before
     * it (the first piece starts at 0). When the pieces still do not match
     * the chapters, which piece is which is not known, and the marks go on a
     * plain line. Null with fewer than two pieces too (no gaps to allow for).
     */
    _chapterLayout(duration) {
        this._chapterUnmeasured = this._chapterInline = false;
        const els = this._chapterElements();
        if (els.length < 2) return null;
        let starts = rendererChapterStarts();
        if (starts.length > els.length) starts = rendererChapterStarts(true);
        if (starts.length && starts.length !== els.length) return null;
        const pieces = [];
        let content = 0;
        let total = 0;
        let unread = false;
        // A piece with a width: the bar is laid out, and a piece with none
        // there (0%, a chapter too short) is 0 px wide. The same test as
        // _chapterNowMeasurable, so the two never send each other round.
        const laidOut = els.some((el) => el.offsetWidth > 0);
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            let width = el.offsetWidth;
            if (!width && !laidOut) {
                // Not laid out (a hidden bar): an inline width in pixels is its
                // width (0px too); a relative one (50%, calc()) or one from a
                // stylesheet (no inline width) is known only once laid out.
                const inline = el.style.width;
                if (/^\d+(?:\.\d+)?px$/.test(inline)) width = parseFloat(inline);
                else unread = true;
            }
            // Margins as laid out; on a bar that is not, only pixel ones (a
            // hidden subtree gives a relative margin back as it is written).
            const cs = window.getComputedStyle(el);
            const margin = (v) => {
                if (laidOut || !v || v === '0' || /^-?\d+(?:\.\d+)?px$/.test(v)) return parseFloat(v) || 0;
                unread = true;
                return 0;
            };
            const ml = margin(cs.marginLeft);
            const mr = margin(cs.marginRight);
            pieces.push({ x: total + ml, width, from: content, to: content + width });
            content += width;
            total += ml + width + mr;
        }
        if (unread || (!laidOut && (!content || !total))) {
            // No width to read yet: see _chapterNowMeasurable.
            this._chapterUnmeasured = true;
            this._watchChapterMeasure();
            return null;
        }
        // Laid out, and still no length to place marks in (negative margins
        // taking it all back): the plain line, with nothing to wait for.
        if (!content || !total) return null;
        // Placed by inline widths on a bar not laid out: a stylesheet (a
        // min-width) may size the pieces otherwise once it is, so the first
        // laid-out sync draws again (_chapterNowMeasurable).
        this._chapterInline = !laidOut;
        for (let i = 0; i < pieces.length; i++) {
            const p = pieces[i];
            if (starts.length) {
                p.from = starts[i];
                p.to = i + 1 < starts.length ? starts[i + 1] : duration;
            } else {
                p.from = (p.from / content) * duration;
                p.to = (p.to / content) * duration;
            }
        }
        // A chapter with no width or no time adds nothing to place a mark in.
        const shown = pieces.filter((p) => p.width > 0 && p.to > p.from);
        if (!shown.length) return null;
        // The pieces shown cover the whole video: the first from 0, each up to
        // the next one shown (the time of one left out goes to the piece before).
        shown[0].from = 0;
        for (let i = 0; i < shown.length; i++) shown[i].to = i + 1 < shown.length ? shown[i + 1].from : duration;
        return { pieces: shown, total };
    }

    /**
     * Marks drawn on the plain line because the chapter pieces had no width
     * to read, or placed by their inline widths on a bar not laid out, and
     * the pieces now have a width: their signature is the same, so only this
     * tells that the chapters can place (or place again) the marks. Reads the
     * layout only while such a draw is waiting.
     */
    _chapterNowMeasurable() {
        if (!this._chapterUnmeasured && !this._chapterInline) return false;
        return this._chapterElements().some((el) => el.offsetWidth > 0);
    }

    /**
     * While the marks wait for the pieces' width, a look once a second: the
     * bar can be shown with no sync coming (a segment shown on the bar only
     * keeps no time listener, and a parent showing it changes nothing the
     * observers watch). Stops at the first draw that waits for no width (by
     * the chapters, or the plain line for another reason), at a draw that
     * places no marks at all, and with the handler.
     */
    _watchChapterMeasure() {
        if (this._measureTimer || this.isDestroyed) return;
        this._measureTimer = setInterval(() => {
            if (this.isDestroyed || !this._chapterUnmeasured) {
                clearInterval(this._measureTimer);
                this._measureTimer = null;
                return;
            }
            if (this._chapterNowMeasurable()) {
                this.lastOverlayHash = null;
                this.drawOverlay();
            }
        }, CHAPTER_MEASURE_MS);
    }

    /**
     * Attribute changes on the chapter pieces themselves, not their subtree
     * (where the playhead writes): a gap or width changed with no other sync
     * coming (no skip segment left to keep the time listener on) redraws the
     * marks.
     */
    _watchChapters() {
        if (typeof MutationObserver === 'undefined') return;
        if (!this._chapterObserver) {
            this._chapterObserver = new MutationObserver((records) => {
                if (this.isDestroyed) return;
                // Pieces replaced, even by ones with the same signature: the new ones are watched.
                if (records.some((r) => r.type === 'childList')) this._watchChapters();
                if (this._chapterSig() === this._drawnChapterSig) return;
                this.requestAF(() => {
                    if (!this.isDestroyed && this._chapterSig() !== this._drawnChapterSig) this.drawOverlay();
                });
            });
            this.observers.add(this._chapterObserver);
        }
        this._chapterObserver.disconnect();
        const els = this._chapterElements();
        for (let i = 0; i < els.length; i++) {
            this._chapterObserver.observe(els[i], { attributes: true, attributeFilter: ['class', 'style'] });
        }
        const track = this._chapterTrack();
        this._watchedTrack = track;
        if (track) this._chapterObserver.observe(track, { childList: true });
    }

    _syncOverlayPosition(ytPB) {
        if (!this.overlay || !ytPB) return;
        const parent = ytPB.parentNode;
        if (!parent) return;

        // Chapter pieces drawn (or resized) after the marks: drawn again over
        // them. Not drawn (no duration yet): the overlay still follows the bar.
        if (this._chapterSig() !== this._drawnChapterSig) {
            this.drawOverlay();
            if (this._chapterSig() === this._drawnChapterSig) return;
        } else if (this._chapterNowMeasurable()) {
            // Pieces that had no width when the marks were drawn have one now.
            this.lastOverlayHash = null;
            this.drawOverlay();
            if (!this._chapterUnmeasured) return;
        }

        // Use the inner slider element for precise height/position.
        // Fall back to ytPB itself only if progressBar is the same node or unset.
        const trackEl = (this.progressBar && this.progressBar !== ytPB)
            ? this.progressBar
            : ytPB;

        // PERF - all READS first, in one batch: interleaving them with writes
        // forced up to 3 synchronous reflows per sync on webOS. classList and
        // the inline-style read are recalc-free, and the inline check still
        // catches UI builds that hide via opacity without the zylon-hidden class.
        const isHidden = ytPB.classList.contains('zylon-hidden') || ytPB.style.opacity === '0';
        const width  = trackEl.offsetWidth;
        const height = trackEl.offsetHeight;
        const pos = this._offsetRelativeTo(trackEl, parent);

        // PERF — skip the style writes entirely when nothing changed (the
        // common case for the 500ms timeupdate sync and mutation-driven syncs).
        const sig = (isHidden ? 'h' : 'v') + '_' + pos.top + '_' + pos.left + '_' + width + '_' + height;
        if (sig === this._lastSyncSig) return;
        // A chaptered bar of another width: pieces with a relative width
        // changed with it, and their marks are placed by what they measure.
        // Not a bar hidden (0 px): its pieces have no width to read then, and
        // shown again at the width it had, nothing changed.
        const resized = width > 0 && this._syncWidth !== undefined && width !== this._syncWidth;
        if (width > 0) this._syncWidth = width;
        if (resized && this._chapterElements().length > 1) {
            this.lastOverlayHash = null;
            this.drawOverlay();
            // Everything filtered out: no overlay left to place.
            if (!this.overlay) return;
        }
        this._lastSyncSig = sig;

        const st = this.overlay.style;
        st.setProperty('opacity', isHidden ? '0' : '1', 'important');
        st.setProperty('top',    pos.top  + 'px', 'important');
        st.setProperty('left',   pos.left + 'px', 'important');
        st.setProperty('width',  width  + 'px', 'important');
        st.setProperty('height', height + 'px', 'important');
    }

    // ==========================================
    // Core Engine
    // ==========================================

    requestAF(callback) {
        if (this.isDestroyed) return;
        const id = requestAnimationFrame(() => {
            this.rafIds.delete(id);
            if (!this.isDestroyed) callback();
        });
        this.rafIds.add(id);
        return id;
    }

    log(level, message, ...args) {
        if ((level === 'debug' || level === 'info') && !this.debugMode) return;
        console[level === 'warn' ? 'warn' : 'log'](this.logPrefix, message, ...args);
    }

    rebuildSkipSegments() {
        this.stopHighFreqLoop();
        this.rebuildMuteSegments();

        if (!this.segments || this.segments.length === 0 || this.activeCategories.size === 0) {
            this.skipSegments = [];
            this.backSegments = [];
            this.resetSegmentTracking();
            return;
        }

        this.skipSegments = [];
        // The ones the backward shortcut seeks to: also those not skipped for
        // Never Skip on These Channels or Ignore Segments Shorter Than, which
        // stay marked on the seek bar.
        this.backSegments = [];
        const config = configGetAll();
        const whitelisted = this.channelWhitelisted();
        const minLength = Number(config.sbMinSegmentLength) || 0;

        const len = this.segments.length;
        for (let i = 0; i < len; i++) {
            const seg = this.segments[i];

            if (seg.category === 'poi_highlight') continue;

            const mode = config[CONFIG_MAPPING[seg.category]];
            if (!mode || mode === 'disable' || mode === 'seek_bar') continue;
            if (seg.actionType && seg.actionType !== 'skip') continue;

            const entry = {
                start: seg.segment[0],
                end: seg.segment[1],
                category: seg.category,
                categoryName: this.getCategoryName(seg.category),
                mode: mode,
                originalIndex: i
            };
            this.backSegments.push(entry);
            // Never Skip on These Channels; Ignore Segments Shorter Than: too
            // short to be worth a jump.
            if (whitelisted || shorterThan(seg.segment[0], seg.segment[1], minLength)) continue;
            this.skipSegments.push(entry);
        }
        this.resetSegmentTracking();
    }

    /**
     * Segments the API marks `mute` are muted rather than skipped, when
     * "Allow segments that mute audio" is on and their category is set to
     * auto or manual skip. The viewer's own mute state comes back on the way
     * out, on a seek away and on destroy.
     */
    rebuildMuteSegments() {
        const config = configGetAll();
        const list = [];
        const minLength = Number(config.sbMinSegmentLength) || 0;
        if (config.enableMutedSegments && this.segments && !this.channelWhitelisted()) {
            for (let i = 0; i < this.segments.length; i++) {
                const seg = this.segments[i];
                if (seg.actionType !== 'mute' || seg.category === 'poi_highlight') continue;
                if (shorterThan(seg.segment[0], seg.segment[1], minLength)) continue;
                const mode = config[CONFIG_MAPPING[seg.category]];
                if (mode !== 'auto_skip' && mode !== 'manual_skip') continue;
                list.push({ start: seg.segment[0], end: seg.segment[1], categoryName: this.getCategoryName(seg.category) });
            }
        }
        this.muteSegments = list;
        this.checkMutedSegment();
    }

    checkMutedSegment() {
        const video = this.video;
        if (!video || this.isDestroyed) return;
        if (!this.muteSegments || this.muteSegments.length === 0) {
            this.leaveMutedSegment();
            return;
        }
        const t = video.currentTime;
        let current = null;
        for (let i = 0; i < this.muteSegments.length; i++) {
            const seg = this.muteSegments[i];
            if (t >= seg.start && t < seg.end) { current = seg; break; }
        }
        if (!current) {
            this.leaveMutedSegment();
            return;
        }
        if (this.mutedSegment === current) return;
        // The list is rebuilt on every settings change: the same segment again.
        const same = !!this.mutedSegment && this.mutedSegment.start === current.start && this.mutedSegment.end === current.end;
        if (!this.mutedSegment) this.mutedBefore = video.muted;
        this.mutedSegment = current;
        video.muted = true;
        if (same) return;
        const name = current.categoryName;
        showNotification(`Muted ${name.charAt(0).toUpperCase() + name.slice(1)} segment`);
    }

    leaveMutedSegment() {
        if (!this.mutedSegment) return;
        this.mutedSegment = null;
        if (this.video) this.video.muted = this.mutedBefore;
    }

    toggleTimeListener(enable) {
        if (!this.video) return;

        if (enable) {
            if (this.video.paused) return;

            if (!this.isTimeListenerActive) {
                this.video.addEventListener('timeupdate', this.boundTimeUpdate);
                this.isTimeListenerActive = true;
                this.log('debug', 'Time listener attached');
            }
        } else if (this.isTimeListenerActive) {
                this.video.removeEventListener('timeupdate', this.boundTimeUpdate);
                this.isTimeListenerActive = false;
                this.log('debug', 'Time listener detached');
        }
    }

    resetSegmentTracking() {
        // Default state
        this.nextSegmentIndex = 0;
        this.nextSegmentStart = this.skipSegments.length > 0 ? this.skipSegments[0].start : Infinity;

        // Find the first segment that starts AFTER the current time, or contains current time.
        if (this.video && !isNaN(this.video.currentTime) && this.skipSegments.length > 0) {
            const time = this.video.currentTime;
            
            // Check if we are currently inside a segment
            const currentIdx = this.findSegmentAtTime(time);
            
            if (currentIdx !== -1) {
                this.nextSegmentIndex = currentIdx;
                this.nextSegmentStart = this.skipSegments[currentIdx].start;
            } else {
                // Not in a segment, find the next one
                this.nextSegmentIndex = this.findNextSegmentIndex(time);
                if (this.nextSegmentIndex < this.skipSegments.length) {
                    this.nextSegmentStart = this.skipSegments[this.nextSegmentIndex].start;
                } else {
                    this.nextSegmentStart = Infinity;
                }
            }
        }

        this.clearManualNotification();
        this.toggleTimeListener(this.nextSegmentStart !== Infinity);
    }

    clearManualNotification() {
        if (this.activeManualNotification) {
            this.activeManualNotification.remove();
            this.activeManualNotification = null;
        }
        this.currentManualSegment = null;
    }

    // Index of the segment containing time, or -1. Segments overlap (a
    // self-promo inside a sponsor, say), so this is a scan, not a binary
    // search: that one missed the outer segment once the probe landed on a
    // nested one already behind. When several contain the time a manual one
    // wins, since a skip must stop there. From mirijanristic's fork.
    findSegmentAtTime(time) {
        let found = -1;
        for (let i = 0; i < this.skipSegments.length; i++) {
            const seg = this.skipSegments[i];
            if (seg.start > time) break;
            if (time >= seg.end) continue;
            if (seg.mode === 'manual_skip') return i;
            if (found === -1) found = i;
        }
        return found;
    }

    // Points nextSegmentIndex/nextSegmentStart at the segment holding time,
    // or else the next one to start.
    aimPast(time) {
        const inside = this.findSegmentAtTime(time);
        this.nextSegmentIndex = inside !== -1 ? inside : this.findNextSegmentIndex(time);
        if (this.nextSegmentIndex < this.skipSegments.length) {
            this.nextSegmentStart = this.skipSegments[this.nextSegmentIndex].start;
        } else {
            this.nextSegmentStart = Infinity;
            this.toggleTimeListener(false);
        }
    }

    // O(log N) - Finds first segment starting after or at time
    findNextSegmentIndex(time) {
        let left = 0;
        let right = this.skipSegments.length - 1;
        let res = this.skipSegments.length;

        while (left <= right) {
            const mid = (left + right) >>> 1;
            if (this.skipSegments[mid].start >= time) {
                res = mid;
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }
        return res;
    }

    setupConfigListeners() {
        this.boundConfigUpdate = () => {
            this.activeCategories.clear();
            const config = configGetAll();
            for (const [cat, configKey] of Object.entries(CONFIG_MAPPING)) {
                if (config[configKey] !== 'disable') this.activeCategories.add(cat);
            }
            this.rebuildSkipSegments();
            this.updateSegmentList();
            this._startBarWatch();
            this.drawOverlay();
            this.updateLabels();
            // An Auto Skip to Start that waited for the channel, with Never
            // Skip on These Channels changed meanwhile (emptied, say).
            this._jumpIfPending();
        };
        
        const configKeys = [...Object.values(CONFIG_MAPPING), ...EXTRA_CONFIG_KEYS];

        for (const key of configKeys) {
            configAddChangeListener(key, this.boundConfigUpdate);
            this.configListeners.push({ key, callback: this.boundConfigUpdate });
        }

        const refreshToggled = (evt) => {
            if (evt.detail.newValue) this.scheduleRefresh();
            else this.clearRefresh();
        };
        configAddChangeListener('sbPeriodicRefresh', refreshToggled);
        this.configListeners.push({ key: 'sbPeriodicRefresh', callback: refreshToggled });
        
        // Initial setup run
        this.boundConfigUpdate();
    }

    buildSkipChain(segments) {
        if (!segments || segments.length === 0) return null;

        // Find the first auto_skip segment that starts at the beginning
        let firstSegIdx = -1;
        for (let i = 0; i < segments.length; i++) {
            if (segments[i].start < CHAIN_SKIP_CONSTANTS.START_THRESHOLD) {
                if (segments[i].mode === 'auto_skip') {
                    firstSegIdx = i;
                    break;
                } else {
                    // If the very first segment is a manual skip at 0.0s, we shouldn't chain auto skips
                    return null;
                }
            } else {
                break;
            }
        }
        
        if (firstSegIdx === -1) return null;

        const firstSeg = segments[firstSegIdx];
        let finalSeekTime = firstSeg.end;
        const chainSegs = [firstSeg];

        for (let i = firstSegIdx + 1; i < segments.length; i++) {
            const current = segments[i];

            // A manual segment ends the chain: at its start when that is inside
            // the chain, where the chain got to otherwise. Passing over one
            // that starts past the chain's end let a later auto segment close
            // behind it carry the jump into it. It is offered there instead.
            if (current.mode !== 'auto_skip') {
                finalSeekTime = Math.min(finalSeekTime, current.start);
                break;
            }

            const gapToNext = current.start - finalSeekTime;
            if (gapToNext > CHAIN_SKIP_CONSTANTS.OVERLAP_TOLERANCE) break;

            if (current.end > finalSeekTime) {
                chainSegs.push(current);
                finalSeekTime = current.end;
            }
        }

        // Cut at the very start by a manual segment: a jump to where playback
        // already is would only come back through 'seeked' and seek again,
        // for good.
        if (finalSeekTime <= CHAIN_SKIP_CONSTANTS.START_THRESHOLD) return null;
        if (chainSegs.length === 1 && finalSeekTime - firstSeg.start < 1) return null;

        // PERF: build the description only once the chain is known-valid —
        // this path runs on every 'seeked' event.
        return {
            endTime: finalSeekTime,
            segments: chainSegs,
            chainDescription: chainSegs
                .map(s => `${s.category}[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s]`)
                .join(' → ')
        };
    }

    executeChainSkip(video) {
        if (!video || this.hasPerformedChainSkip || this.isDestroyed) return false;

        if (video.readyState === 0) {
            if (this.boundChainSkipRetry && this.chainSkipVideo) {
                this.chainSkipVideo.removeEventListener('loadedmetadata', this.boundChainSkipRetry);
            }
            this.chainSkipVideo = video;
            this.boundChainSkipRetry = () => {
                video.removeEventListener('loadedmetadata', this.boundChainSkipRetry);
                this.boundChainSkipRetry = null;
                this.chainSkipVideo = null;
                if (!this.isDestroyed) this.executeChainSkip(video);
            };
            video.addEventListener('loadedmetadata', this.boundChainSkipRetry);
            return false;
        }

        if (video.currentTime > CHAIN_SKIP_CONSTANTS.START_THRESHOLD) return false;

        // Use this.skipSegments instead of filtering out manual skips so buildSkipChain can evaluate them
        if (this.skipSegments.length === 0) return false;

        const chain = this.buildSkipChain(this.skipSegments);
        if (!chain) return false;
        if (chain.endTime >= video.duration) return false;
        // The segment the "skip to previous" shortcut seeked back into plays,
        // as it does everywhere else.
        if (this.tempWhitelistIndex !== -1 &&
            chain.segments.some(seg => seg.originalIndex === this.tempWhitelistIndex)) return false;
        // A segment of an undone skip anywhere the jump would cross, nested
        // inside the chain's segments (a refresh) too, plays. Where the jump
        // starts is also what the statistics count it from (noteSkip).
        const chainStart = video.currentTime;
        if (this.skipSegments.some(seg => seg.start < chain.endTime && seg.end > chainStart && this.isUndone(seg))) return false;
        // With "Skip Segments Once", a chain already skipped (the viewer went
        // back to the start) plays through like any other skipped segment.
        if (configGetAll().skipSegmentsOnce && this.skippedSegmentIndices &&
            chain.segments.every(seg => this.skippedSegmentIndices.has(seg.originalIndex))) return false;

        this.log('info', `Executing chain skip: ${chain.chainDescription}`);

        // Booked like the other skips, so the highlight's seek guard
        // (autoJumpToHighlight) does not take it for YouTube's resume seek.
        this.ownSkipTarget = chain.endTime;
        video.currentTime = chain.endTime;
        this.lastSkipTime = chain.endTime;
        this.hasPerformedChainSkip = true;
        // Reported (noteSkip): every auto segment the jump crossed, in the chain
        // or nested in it, also one a manual segment cut the jump short inside.
        // One already behind where it started was played, not skipped.
        const covered = [];

        // Fast chronologically-sorted short-circuit skip mapping
        for (let i = 0; i < this.skipSegments.length; i++) {
            const seg = this.skipSegments[i];
            if (seg.start >= chain.endTime) break;
            if (seg.mode !== 'auto_skip') continue;

            if (seg.end <= chain.endTime + 0.1) this.skippedSegmentIndices.add(seg.originalIndex);
            if (seg.end > chainStart) covered.push(seg.originalIndex);
        }
        this.noteSkip(chainStart, chain.endTime, covered);

        this.requestAF(() => {
            const categories = chain.chainDescription.split(' → ')
                .map(part => part.split('[')[0])
                .filter((cat, idx, arr) => arr.indexOf(cat) === idx)
                .map(cat => this.getCategoryName(cat));

            showNotification(`Skipped ${categories.join(', ')}`);
        });

        return true;
    }

    getCategoryName(category) {
        return segmentTypes[category]?.name || category;
    }

    /**
     * Whether nothing is to be skipped for Never Skip on These Channels: the
     * video's channel is on the list, or, with a list, its channel is not known
     * yet (the player still reporting the video before counts as not known).
     * Then the segments are built again once it is (a try a second, ten at
     * most); a channel still unknown after that counts as not listed until it
     * is known (looked at again as playback starts, see PLAYING below).
     */
    channelWhitelisted() {
        const list = configRead('sbWhitelistChannels');
        if (!Array.isArray(list) || !list.length) return false;
        const name = currentChannelName(this.videoID);
        if (name) return isChannelWhitelisted(name);
        if ((this.channelRetries || 0) >= CHANNEL_RETRIES) {
            this.channelUnresolved = true;
            return false;
        }
        if (!this.channelRetryTimer && !this.isDestroyed) {
            this.channelRetryTimer = setTimeout(() => {
                this.channelRetryTimer = null;
                if (this.isDestroyed) return;
                this.channelRetries = (this.channelRetries || 0) + 1;
                if (currentChannelName(this.videoID) || this.channelRetries >= CHANNEL_RETRIES) {
                    this.rebuildSkipSegments();
                    // An Auto Skip to Start that waited for the channel.
                    this._jumpIfPending();
                    // The time with skips removed, now that the channel is known.
                    this.updateLabels();
                } else if (!this.channelWhitelisted()) {
                    // The list was emptied meanwhile: nothing to wait for.
                    this.rebuildSkipSegments();
                    this._jumpIfPending();
                    this.updateLabels();
                }
            }, CHANNEL_RETRY_MS);
        }
        return true;
    }

    /** A segment's identity across refreshes: its UUID, or its category and times. */
    segmentKey(index) {
        const seg = this.segments && this.segments[index];
        if (!seg) return '';
        return seg.UUID || `${seg.category}@${seg.segment[0]}-${seg.segment[1]}`;
    }

    /**
     * Whether a skip segment belongs to an undone skip: those segments play
     * until playback passes where their skip had gone (each skip's own end).
     */
    isUndone(skipSeg) {
        const undone = this.undone;
        if (!undone || !this.video) return false;
        const key = this.segmentKey(skipSeg.originalIndex);
        const until = undone.keys.get(key);
        if (until === undefined) return false;
        if (this.video.currentTime >= until) {
            undone.keys.delete(key);
            if (!undone.keys.size) this.clearUndone();
            return false;
        }
        return true;
    }

    /** Ends an undone skip's exemption (playback passed it, or the handler goes). */
    clearUndone() {
        const undone = this.undone;
        if (!undone) return;
        this.undone = null;
        undone.video.removeEventListener('timeupdate', undone.onTime);
    }

    /**
     * A skip made: the time it saved goes into the statistics on the
     * SponsorBlock tab, it can be taken back for a while (handleBlueButton),
     * and, with Count My Skips on SponsorBlock on, each segment is reported
     * as viewed, as SponsorBlock's own extension does.
     */
    noteSkip(from, to, indices) {
        const saved = to - from;
        if (!(saved > 0)) return;
        // The profile whose totals the skip went to (null: none loaded yet).
        this.lastAutoSkip = { from, to, keys: indices.map(i => this.segmentKey(i)), at: Date.now(), profile: configActiveProfile() };
        try {
            configWrite('sbTimeSaved', (Number(configRead('sbTimeSaved')) || 0) + saved);
            configWrite('sbSkipCount', (Number(configRead('sbSkipCount')) || 0) + 1);
        } catch { /* statistics are best effort */ }
        if (!configRead('sbReportSkips')) return;
        for (const idx of indices) {
            const uuid = this.segments[idx] && this.segments[idx].UUID;
            if (typeof uuid !== 'string' || !uuid) continue;
            try {
                fetch(`${SPONSORBLOCK_CONFIG.primaryAPI}/viewedVideoSponsorTime?UUID=${encodeURIComponent(uuid)}`, { method: 'POST' })
                    .catch(() => { /* not counted */ });
            } catch { /* not counted */ }
        }
    }

    /**
     * The last auto skip, taken back: back to where it started, and every
     * segment it jumped over plays (isUndone). Kept by the segments' identity,
     * so a refresh of the list meanwhile does not point it at another one.
     */
    undoLastSkip() {
        const last = this.lastAutoSkip;
        if (!last || !this.video || Date.now() - last.at > UNDO_WINDOW_MS) return false;
        // Taken in one account, another loaded since (a switch that waited for
        // the copy's read, say): not that one's totals to cut. A skip with no
        // profile loaded went to the account the restore then loaded.
        if (last.profile !== null && last.profile !== configActiveProfile()) return false;
        // Moved on since by more than playing (at up to 2x) would have: the
        // viewer seeked elsewhere, and is not sent back.
        const elapsed = (Date.now() - last.at) / 1000;
        if (Math.abs(this.video.currentTime - last.to) > elapsed * 2 + 2) return false;
        this.lastAutoSkip = null;
        // Each segment's key, with where its skip had gone: it plays until then.
        const keys = new Map(last.keys.filter(Boolean).map((key) => [key, last.to]));
        // Its segments gone in a refresh: nothing left to take back.
        if (!this.segments.some((seg, i) => keys.has(this.segmentKey(i)))) return false;
        const video = this.video;
        // An undo still in force on this video keeps its segments playing too
        // (one undone, another skip then undone before passing the first).
        const prior = this.undone && this.undone.video === video ? this.undone : null;
        if (prior) prior.keys.forEach((until, key) => { keys.set(key, Math.max(until, keys.get(key) || 0)); });
        this.clearUndone();
        // Its own timeupdate listener: the skip listener is off once no
        // segment is ahead, and playback passing a skip's end must end its part.
        const onTime = () => {
            keys.forEach((until, key) => { if (video.currentTime >= until) keys.delete(key); });
            if (!keys.size) this.clearUndone();
        };
        this.undone = { keys, video, onTime };
        video.addEventListener('timeupdate', onTime);
        // Our own seek: the highlight's guard (autoJumpToHighlight) leaves it.
        this.ownSkipTarget = last.from;
        video.currentTime = last.from;
        // Its time was not saved after all: taken off the statistics again.
        try {
            configWrite('sbTimeSaved', Math.max(0, (Number(configRead('sbTimeSaved')) || 0) - (last.to - last.from)));
            configWrite('sbSkipCount', Math.max(0, (Number(configRead('sbSkipCount')) || 0) - 1));
        } catch { /* statistics are best effort */ }
        this.requestAF(() => showNotification('Skip undone'));
        return true;
    }

    async init() {
        if (!this.videoID || this.isDestroyed) return;

        this.start();

        const initVideoID = this.videoID;
        sponsorBlockUI.updateSegments([]);

        const hash = sha256(this.videoID);
        if (!hash) return;
        const hashPrefix = hash.substring(0, 4);

        try {
            let data = await this.fetchSegments(hashPrefix);
            // Both servers failed: ask again a couple of times before giving
            // up on this video.
            for (let attempt = 0; data === null && attempt < FETCH_RETRY_DELAYS.length; attempt++) {
                if (this.isDestroyed || this.videoID !== initVideoID) return;
                // eslint-disable-next-line no-await-in-loop
                await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_DELAYS[attempt]));
                if (this.isDestroyed || this.videoID !== initVideoID) return;
                // eslint-disable-next-line no-await-in-loop
                data = await this.fetchSegments(hashPrefix);
            }
            if (this.isDestroyed || this.videoID !== initVideoID) return;
            const videoData = Array.isArray(data) ? data.find(x => x && x.videoID === this.videoID) : data;
            const segments = videoData && Array.isArray(videoData.segments) ? normalizeSegments(videoData.segments) : [];

            if (data === null) this.consecutiveFailures++;

            if (segments.length === 0) {
                if (configGetAll().sbPeriodicRefresh) {
                    // Stay alive with nothing to skip: segments submitted
                    // while this video plays are picked up by the refresh.
                    this.log('debug', 'No SponsorBlock segments yet, will check again');
                    if (data !== null) this.consecutiveEmptyChecks++;
                    this.scheduleRefresh();
                    return;
                }
                this.log('debug', 'No SponsorBlock segments available, cleaning up');
                this.destroy(); 
                return;
            }

            // sort in place is fine
            this.segments = segments.sort((a, b) => a.segment[0] - b.segment[0]);
            this.segmentsSig = segmentsSignature(this.segments);
            this.highlightSegment = this.segments.find(s => s.category === 'poi_highlight');
            this.scheduleRefresh();

            // A <video> that mounted after start() gave up waiting is bound
            // now: a local getVideo() here left this.video null, so no
            // listener was ever attached to it.
            if (!this.video) this.start();
            const video = this.video;
            if (video && video.duration && !isNaN(video.duration)) {
                this.processSegments(video.duration);
            }

            this.rebuildSkipSegments();

            if (video) {
                this.executeChainSkip(video);
            }

            // UI was already started, so now we just update the data.
            // Full-video labels are excluded: they are [0, 0] markers meaning
            // "this whole video is X", not segments, and listing one would show
            // a nonsense 0:00-to-0:00 row.
            this.updateSegmentList();
            
            // Explicitly draw overlay now that data is ready
            // (checkForProgressBar might have run when segments were empty)
            this._startBarWatch();
            this.drawOverlay();
            this.updateLabels();

            if (this.highlightSegment) {
                const config = configGetAll();
                const hlMode = config.sbMode_highlight;
                if (hlMode === 'auto_skip') {
                    // No <video> with the video loaded yet: jumped to once one
                    // is (bindVideo, 'loadedmetadata'). An unplayable video
                    // never loads, so it is never jumped on.
                    if (hasMedia(this.video)) this.autoJumpToHighlight();
                    else this.highlightPending = true;
                } else if (hlMode === 'ask') {
                    showNotification('Highlight available: Press Blue to jump');
                }
            }
        } catch (e) {
            if (!this.isDestroyed) {
                showNotification('SB Error: ' + e.message);
                this.log('warn', 'Fetch failed', e);
            }
        }
    }

    /**
     * Binds the <video>, or waits for it to mount. Re-entered on a late mount,
     * after the fetch, on a PLAYING state without a <video>, and when the
     * element is replaced; the window listeners and the bar watch are set up
     * once and are not touched by a rebind.
     */
    start() {
        if (this.isDestroyed) return;
        this._bindWindowEvents();

        // getVideo() caches with an isConnected guard and invalidates on page
        // change; the wait below fires the instant the element mounts.
        const video = getVideo();
        if (video) {
            this._stopVideoWait();
            this.bindVideo(video);
            return;
        }
        this._waitForVideo();
    }

    // Waits for the <video> itself, or a player subtree mounted with one
    // inside (the old wait matched only a bare <video> node, and gave up for
    // good after 10s). A wait that runs out is armed again by the next
    // PLAYING state and when the segments arrive.
    _waitForVideo() {
        if (this._videoWait || this.isDestroyed) return;
        const hasVideo = (n) => n.nodeType === 1 &&
            (n instanceof HTMLVideoElement || !!(n.querySelector && n.querySelector('video')));
        const obs = new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i++) {
                const added = mutations[i].addedNodes;
                for (let j = 0; j < added.length; j++) {
                    if (hasVideo(added[j])) {
                        this._stopVideoWait();
                        if (!this.isDestroyed) this.start();
                        return;
                    }
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        this.observers.add(obs);
        this._videoWait = obs;
        this._videoWaitTimer = setTimeout(() => this._stopVideoWait(), 30000);
    }

    _stopVideoWait() {
        if (this._videoWaitTimer) {
            clearTimeout(this._videoWaitTimer);
            this._videoWaitTimer = null;
        }
        if (this._videoWait) {
            this._videoWait.disconnect();
            this.observers.delete(this._videoWait);
            this._videoWait = null;
        }
    }

    _bindWindowEvents() {
        if (this.boundStateChange) return;
        this.boundStateChange = (e) => {
            const state = e.detail.state;
            
            if (state === 0) { // ENDED
                this.hasPerformedChainSkip = false;
                this.toggleTimeListener(false);
                // FIX (replay): the end screen is about to tear down the player
                // chrome. Invalidate the cached drawing context so a replay
                // rebuilds from scratch — on replay every input to the overlay
                // hash is identical, so a stale hash would suppress the redraw.
                this.lastOverlayHash = null;
                this._anchorCache = null;
                this._anchorCacheBar = null;
                this._lastSyncSig = null;
            } else if (state === 1) { // PLAYING
                // A <video> that mounted after the wait for it ran out.
                if (!this.video) this.start();
                // Check for progress bar existence on play in case UI was destroyed (e.g. after side-panel interaction)
                this._ensureObserverAlive();
                this.checkForProgressBar();
                // Re-evaluate tracking (re-enables time listener if needed)
                this.resetSegmentTracking();
                this.hasPerformedChainSkip = false;
                // A channel still unknown after its retries, known by now: the
                // segments are built again for Never Skip on These Channels.
                // One lookup a play while unresolved, none otherwise.
                if (this.channelUnresolved && currentChannelName(this.videoID)) {
                    this.channelUnresolved = false;
                    this.rebuildSkipSegments();
                    this.updateLabels();
                }
                this.executeChainSkip(this.video);
            } else if (state === 2) { // PAUSED
                this.stopHighFreqLoop();
                this.toggleTimeListener(false);
            }
        };
        
        window.addEventListener('yt-player-state-change', this.boundStateChange);

        // The statistics an undo takes back are the profile's that earned them:
        // switched away from that profile, the skip is not the new one's to take
        // back. Loaded from none (the restore of the copy loading the account in
        // use), the skip's totals went to that account, so it stays.
        if (this.boundProfileChange) window.removeEventListener('ytaf-profile-change', this.boundProfileChange);
        // A skip counted with no account loaded can be undone in the account
        // that took those counters: the one the restore loads (its merge), or
        // one started from the shared settings; any other never had them.
        this.boundProfileChange = (evt) => {
            const detail = evt && evt.detail ? evt.detail : {};
            if (!(detail.from === null && (detail.restored || detail.seeded))) this.lastAutoSkip = null;
        };
        window.addEventListener('ytaf-profile-change', this.boundProfileChange);

        // Resize forces an immediate overlay re-sync (bypassing the timeupdate throttle).
        if (this.boundResize) window.removeEventListener('resize', this.boundResize);
        this.boundResize = () => {
            this._lastSyncTime = 0;
            if (this.overlay && this.progressBar && !this.isDestroyed) {
                // Marks on a chaptered bar are placed by its measured width,
                // which the chapter signature does not track.
                if (this._chapterElements().length > 1) {
                    this.lastOverlayHash = null;
                    this.drawOverlay();
                }
                const { container, asSibling } = this._getProgressBarAnchor();
                if (asSibling && container) this._syncOverlayPosition(container);
            }
        };
        window.addEventListener('resize', this.boundResize);
    }

    /** Lets go of the bound <video>: its listeners, the frame loop, the mute. */
    _unbindVideo() {
        const old = this.video;
        if (!old) return;
        this._endHighlightGuard();
        // An undone skip belongs to the <video> it was undone on.
        this.clearUndone();
        this.lastAutoSkip = null;
        this.leaveMutedSegment();
        this.stopHighFreqLoop();
        if (this.isTimeListenerActive) {
            old.removeEventListener('timeupdate', this.boundTimeUpdate);
            this.isTimeListenerActive = false;
        }
        const events = this.listeners.get(old);
        if (events) {
            events.forEach((handler, type) => { old.removeEventListener(type, handler); });
            this.listeners.delete(old);
        }
        if (this.chainSkipVideo === old && this.boundChainSkipRetry) {
            old.removeEventListener('loadedmetadata', this.boundChainSkipRetry);
            this.boundChainSkipRetry = null;
            this.chainSkipVideo = null;
        }
        this.video = null;
    }

    bindVideo(video) {
        if (this.video === video) return;
        this._unbindVideo();
        this.video = video;
        // CSS is loaded via static import (./sponsorblock.css) — no runtime
        // <style> injection needed.
        this.resetSegmentTracking();

        this.addEvent(this.video, 'seeked', () => {
            if (this.isDestroyed) return;
            // The undo is for the skip's own seek landing and playback from
            // there: any other seek moved away, and Blue no longer goes back.
            const skip = this.lastAutoSkip;
            if (skip) {
                if (skip.landed || Math.abs(this.video.currentTime - skip.to) > 2) this.lastAutoSkip = null;
                else skip.landed = true;
            }
            this.checkMutedSegment();
            this._clearSkipWatchdog();
            this.stopHighFreqLoop();
            this.hasPerformedChainSkip = false;
            this.executeChainSkip(this.video);

            if (!this.isSkipping) {
                this.lastSkipTime = -1;
                this.lastSkippedSegmentIndex = -1;
                this.lastNotifiedSegmentIndex = -1;
                this.resetSegmentTracking();
                // Only handle time update immediately if not paused
                if (!this.video.paused) this.handleTimeUpdate(); 
            }
            this.isSkipping = false;
        });

        this.addEvent(this.video, 'durationchange', () => {
            if (this.video?.duration) {
                this.processSegments(this.video.duration);
                this.drawOverlay();
                this.updateLabels();
            }
        });

        this.addEvent(this.video, 'loadedmetadata', () => {
            if (!this.isDestroyed) this._jumpIfPending();
        });

        this.addEvent(this.video, 'timeupdate', () => {
            if (this.muteSegments && (this.muteSegments.length || this.mutedSegment)) this.checkMutedSegment();
        });

        this.addEvent(this.video, 'playing', () => {
            if (this.isDestroyed) return;
            if (this.refreshPending) this.refreshSegments();
            this.resetSegmentTracking();
        });
        this.addEvent(this.video, 'pause', () => {
            this.stopHighFreqLoop();
            this.toggleTimeListener(false);
        });

        if (this.video.duration) this.processSegments(this.video.duration);

        // Segments that arrived before the <video>: the start chain, and a
        // bar tracked before it had no duration to draw with.
        if (this.skipSegments.length) this.executeChainSkip(this.video);
        this.drawOverlay();
        this.updateLabels();

        this._jumpIfPending();

        this._startBarWatch();
    }

    /**
     * The segments the settings panel lists: not a whole-video label, and not
     * a mute segment while "Allow segments that mute audio" is off, where it
     * is neither muted nor skipped (the extension does not even ask for them
     * then).
     */
    updateSegmentList() {
        const muting = !!configGetAll().enableMutedSegments;
        sponsorBlockUI.updateSegments(this.segments.filter(s => !isFullVideoSegment(s) && s.category !== 'chapter' &&
            (muting || s.actionType !== 'mute')));
    }

    /**
     * The community's chapters of this video, in order: [{ start, end, name }].
     * Skip to Next/Previous Chapter falls back to them (ui.js).
     */
    communityChapters() {
        const out = [];
        for (const seg of this.segments || []) {
            if (seg.category !== 'chapter' || !seg.segment) continue;
            const start = Number(seg.segment[0]);
            const end = Number(seg.segment[1]);
            if (!isFinite(start) || !isFinite(end) || end <= start) continue;
            out.push({ start, end, name: typeof seg.description === 'string' ? seg.description.trim() : '' });
        }
        return out.sort((a, b) => a.start - b.start);
    }

    /**
     * Whether drawOverlay() may draw a mark for this segment (on a chaptered
     * bar one starting at or after the end, or of no length, gets none).
     */
    _isDrawable(segment, config) {
        // A full-video label spans [0, 0] and would draw a zero-width bar.
        if (isFullVideoSegment(segment)) return false;
        // A mute segment does nothing while muting is off: no mark for it.
        if (segment.actionType === 'mute' && !config.enableMutedSegments) return false;
        const mode = segment.category === 'poi_highlight'
            ? config.sbMode_highlight
            : config[CONFIG_MAPPING[segment.category]];
        return !!mode && mode !== 'disable';
    }

    /**
     * PERF: the bar is only watched once there is something to draw on it. A
     * video with no segments (kept alive by the periodic refresh) or only a
     * whole-video label used to run the observers, the bar poll and the
     * overlay machinery for nothing. Called when the <video> is bound, when
     * segments arrive or change, and when a setting changes; once started it
     * stays on for the video.
     */
    _startBarWatch() {
        if (this._barObserverStarted || this.isDestroyed || !this.segments.length) return;
        const config = configGetAll();
        if (!this.segments.some(seg => this._isDrawable(seg, config))) return;
        this._barObserverStarted = true;
        this.observePlayerUI();
        this.checkForProgressBar();
    }

    _disconnectBarObservers() {
        if (this.domObserver) {
            this.domObserver.disconnect();
            this.observers.delete(this.domObserver);
            this.domObserver = null;
        }
        if (this._attrObserver) {
            this._attrObserver.disconnect();
            this.observers.delete(this._attrObserver);
            this._attrObserver = null;
        }
        if (this._finderObserver) {
            this._finderObserver.disconnect();
            this.observers.delete(this._finderObserver);
            this._finderObserver = null;
        }
    }

    observePlayerUI() {
        // Re-run when the observed root was torn down: the old observers go,
        // including a finder still waiting (they used to pile up, one more
        // per call).
        this._disconnectBarObservers();

        // Both bar layouts: the old finder waited for ytlr-progress-bar only,
        // and never attached where the TV UI renders the multi-markers bar
        // without it. The outer renderer is the one the overlay sits beside.
        const BAR_SELECTOR = 'ytlr-progress-bar, ytlr-multi-markers-player-bar-renderer';
        const findBar = () => document.querySelector('ytlr-multi-markers-player-bar-renderer') ||
                              document.querySelector('ytlr-progress-bar');

        const startOptimizedObserver = (targetNode) => {
            this._disconnectBarObservers();
            // Observe parent to catch if the bar itself is destroyed/recreated by the framework
            const observeTarget = targetNode.parentNode || targetNode;
            this._observedRoot = observeTarget;
            this.log('info', 'Attaching optimized observer to:', observeTarget.tagName);
            
            const scheduleCheck = () => {
                if (this.isProcessing || this.isDestroyed) return;
                this.isProcessing = true;
                this.requestAF(() => {
                    this.checkForProgressBar();
                    this.isProcessing = false;
                });
            };

            // PERF: two narrow observers rather than one attributes+subtree
            // observer, which woke a callback every animation frame on
            // YouTube's playhead style writes just to filter them out in JS.
            // 1) childList-only subtree observer - catches the bar being
            //    destroyed/recreated by the framework.
            this.domObserver = new MutationObserver(scheduleCheck);
            this.domObserver.observe(observeTarget, { childList: true, subtree: true });
            this.observers.add(this.domObserver);

            // 2) attribute observer pinned to the tracked bar element itself
            //    (no subtree); re-targeted in checkForProgressBar whenever the
            //    bar is (re)acquired.
            this._attrObserver = new MutationObserver(scheduleCheck);
            this.observers.add(this._attrObserver);
            this.checkForProgressBar();
        };

        const candidate = findBar();
        if (candidate) {
            startOptimizedObserver(candidate);
        } else {
            const root = document.querySelector('ytlr-app') || document.body;
            this.log('info', 'Waiting for optimized container:', BAR_SELECTOR);

            // One finder at a time, kept on the instance so it can be dropped.
            const finderObserver = new MutationObserver(() => {
                const found = findBar();
                if (found) startOptimizedObserver(found);
            });

            finderObserver.observe(root, { childList: true, subtree: true });
            this.observers.add(finderObserver);
            this._finderObserver = finderObserver;
        }
    }

    // Only the <video> is rebound: re-running the whole setup re-ran
    // observePlayerUI() and dropped the bar observers with every new element.
    _rebindVideo() {
        this._unbindVideo();
        this.log('info', 'Video element was replaced — rebinding');
        this.start();
    }

    // FIX (replay): domObserver is attached to a specific container captured at
    // setup time. When a video reaches the end, the TV UI tears down the whole
    // player chrome — including that container — and rebuilds it when playback
    // restarts. The observer survives but is now watching a DETACHED node, so
    // it never sees the new progress bar appear and checkForProgressBar() is
    // never called again. Loading a different video always worked because that
    // fires a hashchange -> full re-init -> fresh observers; replay fires no
    // hashchange, so nothing ever re-armed them.
    _ensureObserverAlive() {
        if (this.isDestroyed || !this._barObserverStarted) return;
        // A finder is already waiting for the bar to come back.
        if (this._finderObserver) return;
        if (this._observedRoot && this._observedRoot.isConnected) return;
        this.log('info', 'Observer root was destroyed — re-attaching');
        this.observePlayerUI();
    }

    // Bounded poll for the progress bar. The observer alone is not enough on
    // replay: the chrome is rebuilt asynchronously AFTER playback starts.
    _scheduleBarRetry() {
        if (this._barRetryTimer || this.isDestroyed) return;
        let attempts = 0;
        this._barRetryTimer = setInterval(() => {
            if (this.isDestroyed || ++attempts > 40) { // ~10s ceiling
                clearInterval(this._barRetryTimer);
                this._barRetryTimer = null;
                return;
            }
            if (this.overlay && this.overlay.isConnected) {
                clearInterval(this._barRetryTimer);
                this._barRetryTimer = null;
                return;
            }
            this._ensureObserverAlive();
            this.checkForProgressBar();
        }, 250);
    }

    checkForProgressBar() {
        if (this.isDestroyed) return;

        if (this.video && !this.video.isConnected) {
            this._rebindVideo();
        }

        if (!this._barObserverStarted) return;

        this._ensureObserverAlive();

        // PERF: cheap path keyed on the tracked bar still being in the DOM.
        // Re-sync only when there is an overlay; a bar drawn with nothing to
        // show (every segment filtered out) needs no re-acquire either - it
        // used to run the selector list, getComputedStyle and a full overlay
        // rebuild on every mutation. Input changes call drawOverlay() directly.
        if (this.progressBar && this.progressBar.isConnected) {
            // The chapter row itself replaced under a bar still in place (the
            // renderer tracked as the bar), by pieces of the same signature:
            // nothing redraws, so the new row and its pieces are watched here.
            if (this._chapterObserver && this._chapterTrack() !== this._watchedTrack) this._watchChapters();
            if (this.overlay && this.overlay.isConnected) {
                // Ensure the sibling overlay syncs visibility when attributes mutate
                const { container, asSibling } = this._getProgressBarAnchor();
                if (asSibling && container) {
                    this._syncOverlayPosition(container);
                }
                return;
            }
            if (!this.overlay && this.lastOverlayHash !== null) return;
        }

        // If the overlay was orphaned or wiped, clear it so drawOverlay creates a fresh one
        if (this.overlay && !this.overlay.isConnected) {
            this.overlay.remove();
            this.overlay = null;
        }

        let target = null;

        // Try the cached selector first
        if (this.activeBarSelector) {
            target = document.querySelector(this.activeBarSelector);
        }

        // Iterate list only if cache missed
        if (!target) {
            const selectors = [
                'ytlr-multi-markers-player-bar-renderer [idomkey="segment"]',
                'ytlr-multi-markers-player-bar-renderer [idomkey="progress-bar"]',
                'ytlr-multi-markers-player-bar-renderer',
                'ytlr-progress-bar [idomkey="slider"]',
                '.ytLrProgressBarSliderBase',
                '.afTAdb'
            ];

            for (const selector of selectors) {
                target = document.querySelector(selector);
                if (target) {
                    this.activeBarSelector = selector;
                    break;
                }
            }
        }

        if (target) {
            this.progressBar = target;
            // Bar (re)acquired — drop the cached anchor so _getProgressBarAnchor
            // recomputes the positioning context for the new element.
            this._anchorCache = null;
            this._anchorCacheBar = null;

            if (this._attrObserver) {
                this._attrObserver.disconnect();
                this._attrObserver.observe(target, {
                    attributes: true,
                    attributeFilter: ['class', 'style', 'hidden']
                });
            }
            
            const style = window.getComputedStyle(target);
            if (style.position === 'static') target.style.position = 'relative';
            if (style.overflow !== 'visible') target.style.setProperty('overflow', 'visible', 'important');
            
            this.drawOverlay();

            if (this._barRetryTimer && this.overlay && this.overlay.isConnected) {
                clearInterval(this._barRetryTimer);
                this._barRetryTimer = null;
            }
        } else {
            // FIX (replay): bar not in the DOM yet — keep looking instead of
            // giving up silently and waiting for an observer callback that may
            // never come.
            this.progressBar = null;
            this._anchorCache = null;
            this._anchorCacheBar = null;
            this._scheduleBarRetry();
        }
    }

    drawOverlay() {
        // A draw that places no marks at all (no segments, no bar, no
        // duration, all filtered out) ends the look for a width
        // (_watchChapterMeasure); one unchanged since the last keeps it.
        if (this.isDestroyed || !this._barObserverStarted || !this.segments.length) {
            this._chapterUnmeasured = this._chapterInline = false;
            return;
        }

        // FIX (replay): a detached progressBar is still truthy. Drawing against
        // it inserted the overlay into an orphaned subtree — which is why the
        // segments existed but never showed, and flashed briefly when a seek
        // caused the stale node to be touched.
        if (!this.progressBar || !this.progressBar.isConnected) {
            this.progressBar = null;
            this._anchorCache = null;
            this._anchorCacheBar = null;
            this.lastOverlayHash = null;
            this._chapterUnmeasured = this._chapterInline = false;
            this._scheduleBarRetry();
            return;
        }

        const duration = this.video ? this.video.duration : 0;
        if (!duration || isNaN(duration)) {
            this._chapterUnmeasured = this._chapterInline = false;
            return;
        }

        const config = configGetAll();
        // Include a signature of every segment color so changing a color
        // mid-video invalidates the hash and forces a redraw (§5b fix).
        let colorSig = '';
        for (const k in segmentTypes) colorSig += config[`${k}Color`] || '';
        this._drawnChapterSig = this._chapterSig();
        this._watchChapters();
        const overlayHash = `${duration}_${this.activeCategories.size}_${this.segments.length}_${config.sbMode_highlight}_${!!config.enableMutedSegments}_${colorSig}_${this._drawnChapterSig}`;
        if (overlayHash === this.lastOverlayHash && this.overlay && this.overlay.isConnected) {
            return;
        }
        this.lastOverlayHash = overlayHash;

        if (this.overlay) this.overlay.remove();

        const fragment = document.createDocumentFragment();
        // A chaptered bar has gaps between its chapters: the marks follow the
        // chapters (one mark per chapter for a segment across a gap), not a
        // plain time-to-percent line that drifts by the gaps.
        const layout = this._chapterLayout(duration);

        const len = this.segments.length;
        for (let i = 0; i < len; i++) {
            const segment = this.segments[i];
            if (!this._isDrawable(segment, config)) continue;
            const isHighlight = segment.category === 'poi_highlight';

            // Destructuring avoidance for speed, plus batch styling execution
            const start = segment.segment[0];
            const end = segment.segment[1];

            const colorKey = isHighlight ? 'poi_highlightColor' : `${segment.category}Color`;
            const color = config[colorKey] || segmentTypes[segment.category]?.color || '#00d400';

            if (isHighlight) {
                const left = layout ? barPercentAt(layout, start) : (start / duration) * 100;
                const div = document.createElement('div');
                div.className = 'previewbar highlight';
                div.style.cssText = `background-color: ${color}; position: absolute; height: 100%; top: 0; left: ${left}%; z-index: 2001;`;
                fragment.appendChild(div);
                continue;
            }
            const opacity = segmentTypes[segment.category]?.opacity || '0.7';
            const ranges = layout ? barRanges(layout, start, end) :
                [{ left: (start / duration) * 100, width: ((end - start) / duration) * 100 }];
            for (let r = 0; r < ranges.length; r++) {
                const div = document.createElement('div');
                div.className = 'previewbar';
                div.style.cssText = `background-color: ${color}; position: absolute; height: 100%; top: 0; left: ${ranges[r].left}%; width: ${ranges[r].width}%; opacity: ${opacity}; z-index: 2000;`;
                fragment.appendChild(div);
            }
        }

        // Everything was filtered out (e.g. the only entry was a full-video
        // label). Leave the bar clean rather than inserting an empty overlay.
        if (!fragment.childNodes.length) {
            this.overlay = null;
            this._chapterUnmeasured = this._chapterInline = false;
            return;
        }

        this.overlay = document.createElement('div');
        this.overlay.id = 'previewbar';
        this._lastSyncSig = null; // fresh element — force the next geometry sync
        this.overlay.appendChild(fragment);

        const { container, asSibling } = this._getProgressBarAnchor();
        if (asSibling) {
            // insertAdjacentElement('afterend') requires Chrome 41+, not available on
            // WebOS 3 (Chrome 38). Use insertBefore with nextSibling instead.
            const nextSib = container.nextSibling;
            if (nextSib) {
                container.parentNode.insertBefore(this.overlay, nextSib);
            } else {
                container.parentNode.appendChild(this.overlay);
            }
            this._syncOverlayPosition(container);
        } else {
            container.appendChild(this.overlay);
        }

        // FIX (replay): if the insert landed in an orphaned subtree, drop the
        // hash so the next pass rebuilds rather than early-returning on an
        // unchanged hash (identical video = identical hash on replay).
        if (!this.overlay.isConnected) {
            this.lastOverlayHash = null;
            this._scheduleBarRetry();
        }
    }

    /**
     * Refresh the title badge and the skips-removed duration.
     *
     * Cheap and idempotent, so it is called from anywhere the inputs can move:
     * after the fetch, on durationchange, and whenever a SponsorBlock setting
     * changes.
     */
    updateLabels() {
        if (this.isDestroyed) return;
        const video = this.video || getVideo();
        const duration = video && !isNaN(video.duration) ? video.duration : 0;
        sponsorBlockLabels.update(this.segments, duration, { noSkips: this.channelWhitelisted() });
    }

    processSegments(duration) {
        if (!duration || isNaN(duration)) return;

        // The end always comes from the one the API gave (apiEnd, kept on the
        // first clamp). Overwriting segment[1] with the duration lost it for
        // good: a short duration reported early (before the real one) cut the
        // segment off for the rest of the video. From mirijanristic's fork.
        let changed = false;
        for (const segment of this.segments) {
            if (segment.apiEnd === undefined) segment.apiEnd = segment.segment[1];
            let end = Math.min(segment.apiEnd, duration);
            if (this.isLegacyWebOSVer && end >= duration - 0.5) {
                end = Math.max(0, duration - 0.30);
            }
            if (segment.segment[1] !== end) {
                segment.segment[1] = end;
                changed = true;
            }
        }

        if (changed) {
            this.rebuildSkipSegments();
        }
    }

    // Safety net: if the media pipeline swallows the 'seeked' event for a
    // programmatic skip (buffer stalls / near-EOS quirks on webOS), clear the
    // isSkipping latch so the timeupdate pipeline keeps working. Mirrors the
    // 500ms fallback handleBlueButton already had, with headroom for slow seeks.
    _armSkipWatchdog() {
        if (this._skipWatchdogTimer) clearTimeout(this._skipWatchdogTimer);
        this._skipWatchdogTimer = setTimeout(() => {
            this._skipWatchdogTimer = null;
            if (!this.isDestroyed && this.isSkipping) {
                this.log('warn', "'seeked' never fired after skip — watchdog reset");
                this.isSkipping = false;
                this.resetSegmentTracking();
            }
        }, 1500);
    }

    _clearSkipWatchdog() {
        if (this._skipWatchdogTimer) {
            clearTimeout(this._skipWatchdogTimer);
            this._skipWatchdogTimer = null;
        }
    }

    startHighFreqLoop() {
        if (!this.pollingRafId && this.nextSegmentStart !== Infinity && !this.isDestroyed) {
            this.pollingRafId = requestAnimationFrame(this.boundHighFreqLoop);
        }
    }

    stopHighFreqLoop() {
        if (this.pollingRafId) {
            cancelAnimationFrame(this.pollingRafId);
            this.pollingRafId = null;
        }
    }

    highFreqLoop() {
        if (this.isDestroyed || !this.video || this.video.paused || this.isSkipping) {
            this.stopHighFreqLoop();
            return;
        }

        // Only process time update if we are close to the target
        if (this.video.currentTime >= this.nextSegmentStart) {
            this.handleTimeUpdate();
            this.stopHighFreqLoop();
        } else {
            this.pollingRafId = requestAnimationFrame(this.boundHighFreqLoop);
        }
    }

    handleTimeUpdate() {
        if (this.isSkipping) return;

        // Sync overlay layout at most every 500ms — timeupdate fires ~4Hz and the
        // viewport rarely changes, so the previous unconditional sync wasted two
        // getBoundingClientRect() calls + DOM writes per frame on webOS 3.
        if (this.overlay && this.progressBar) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (!this._lastSyncTime || now - this._lastSyncTime > 500) {
                const { container, asSibling } = this._getProgressBarAnchor();
                if (asSibling && container) {
                    this._syncOverlayPosition(container);
                }
                this._lastSyncTime = now;
            }
        }

        if (this.skipSegments.length === 0) {
            this.toggleTimeListener(false);
            return;
        }
        if (this.isDestroyed || !this.video || this.video.seeking || this.video.readyState === 0) return;

        const currentTime = this.video.currentTime;

        if (this.currentManualSegment) {
            if (currentTime < this.currentManualSegment.start || currentTime >= this.currentManualSegment.end) {
                this.clearManualNotification();
            }
        }

        // Trust nextSegmentStart to avoid unnecessary searches
        const timeToNext = this.nextSegmentStart - currentTime;

		// Removed sleep timer due to possible bugs with buffering/frame drops
        // if (timeToNext > 3.0 && !this.currentManualSegment) {
            // const sleepTime = timeToNext - 1.0;
            // if (sleepTime > 1.0) {
                // this.toggleTimeListener(false);
                // this.longDistanceTimer = setTimeout(() => {
                    // this.longDistanceTimer = null;
                    // this.toggleTimeListener(true);
                // }, sleepTime * 1000);
                // return;
            // }
        // }

        if (timeToNext > 0 && !this.currentManualSegment) {
            if (timeToNext < 1.0 && !this.pollingRafId) {
                this.startHighFreqLoop();
            }
            // Early exit if we are not yet at the segment start
            return;
        }

        // The predicted segment is trusted outright only when it is a manual
        // one holding the playhead; otherwise the scan decides, since a manual
        // segment nested in the predicted one takes precedence.
        let segmentIdx = -1;
        const expectedSeg = this.skipSegments[this.nextSegmentIndex];

        if (expectedSeg && currentTime >= expectedSeg.start) {
            if (expectedSeg.mode === 'manual_skip' && currentTime < expectedSeg.end) {
                segmentIdx = this.nextSegmentIndex;
            } else {
                segmentIdx = this.findSegmentAtTime(currentTime);
                // Only apply the 1.5s frame drop gap to auto_skip segments
                if (segmentIdx === -1 && expectedSeg.mode === 'auto_skip' &&
                    currentTime - expectedSeg.end < 1.5) {
                    segmentIdx = this.nextSegmentIndex;
                }
            }
        }

        if (segmentIdx === -1) {
            // We aren't in a segment. Since resetSegmentTracking was correct, 
            // and we checked timeToNext, we are just between segments or past the last one.
            
            // Re-sync next segment just in case (e.g. slight drift)
            if (currentTime >= this.nextSegmentStart) {
                 this.nextSegmentIndex = this.findNextSegmentIndex(currentTime);
                 if (this.nextSegmentIndex < this.skipSegments.length) {
                     this.nextSegmentStart = this.skipSegments[this.nextSegmentIndex].start;
                 } else {
                     this.nextSegmentStart = Infinity;
                     this.toggleTimeListener(false);
                 }
            }
            this.tempWhitelistIndex = -1;
            return;
        }

        // We are inside a segment
        const seg = this.skipSegments[segmentIdx];
        
        if (this.tempWhitelistIndex !== -1 && seg.originalIndex !== this.tempWhitelistIndex) {
            this.tempWhitelistIndex = -1;
        }

        if (seg.mode === 'manual_skip') {
            if (this.currentManualSegment !== seg) {
                this.currentManualSegment = seg;
                const categoryName = seg.categoryName;
                const title = categoryName.charAt(0).toUpperCase() + categoryName.slice(1);

                if (this.activeManualNotification) this.activeManualNotification.remove();
                // The Skip button, bottom right (sponsorblock-skip-button.js):
                // the key skips it, and so does the Magic Remote pointer. The
                // button only skips: taking an auto skip back is the key's.
                this.activeManualNotification = showSkipButton(title, () => this.skipManualSegment());
            }
            return;
        }

        if (seg.mode !== 'auto_skip') {
            if (segmentIdx !== this.lastNotifiedSegmentIndex) {
                this.lastNotifiedSegmentIndex = segmentIdx;
                const categoryName = seg.categoryName;
                showNotification(`${categoryName.charAt(0).toUpperCase() + categoryName.slice(1)} segment`);
            }
            return;
        }
        
        if (seg.originalIndex === this.tempWhitelistIndex) {
            return;
        }
        if (this.isUndone(seg)) return;

        const config = configGetAll();
        if (config.skipSegmentsOnce && this.skippedSegmentIndices.has(seg.originalIndex)) {
            return;
        }

        if (this.isLegacyWebOSVer &&
            segmentIdx === this.lastSkippedSegmentIndex &&
            this.video.duration - currentTime < 1.0) {
            return;
        }

        let jumpTarget = seg.end;
        // The segments the jump takes in; those it crosses are counted below.
        const chained = [seg];

        for (let i = segmentIdx + 1; i < this.skipSegments.length; i++) {
            const next = this.skipSegments[i];

            // Already behind the playhead: not crossed by the jump, so not
            // marked or reported as skipped, and no reason to stop it. Stopping
            // at the start of a manual one sent the skip backwards, into the
            // outer segment again, and the "Skipped" toast repeated ~4 times a
            // second while nothing was skipped.
            if (next.end <= currentTime) continue;

            // A segment of an undone skip plays: the jump stops at its start,
            // and is none at all if that start is already behind (a refresh
            // put a segment before it that overlaps it).
            if (this.isUndone(next)) {
                if (next.start < jumpTarget) jumpTarget = next.start;
                break;
            }

            if (next.mode !== 'auto_skip') {
                if (next.start < jumpTarget) {
                    jumpTarget = next.start;
                }
                break;
            }
            if (next.start > jumpTarget + 0.2) break;

            jumpTarget = Math.max(jumpTarget, next.end);
            chained.push(next);
        }

        if (segmentIdx === this.lastSkippedSegmentIndex && Math.abs(currentTime - this.lastSkipTime) < 0.1) {
            return;
        }

        if (this.isLegacyWebOSVer) {
            const duration = this.video.duration;
            if (jumpTarget >= duration - 0.5) {
                jumpTarget = Math.max(0, duration - 0.25);
            }
        }

        if (jumpTarget <= currentTime + 0.05) {
            // Nothing ahead to skip: the segment ends here, or a manual one
            // starts here. Aim past it without booking or announcing a skip.
            this.aimPast(jumpTarget);
            return;
        }

        // Only those the final jump crosses: one a later manual segment cut
        // off at its start is neither marked, reported nor undone.
        const crossed = chained.filter(s => s.start < jumpTarget);
        const skippedCategories = crossed.map(s => s.categoryName);
        const segmentsToMark = crossed.map(s => s.originalIndex);

        this.lastSkipTime = currentTime;
        this.lastSkippedSegmentIndex = segmentIdx;
        
        segmentsToMark.forEach(idx => { this.skippedSegmentIndices.add(idx); });

        this.isSkipping = true;
        this._armSkipWatchdog();
        this.ownSkipTarget = jumpTarget;
        this.video.currentTime = jumpTarget;
        this.noteSkip(currentTime, jumpTarget, segmentsToMark);

        if (!this.isLegacyWebOSVer) {
            const timeRemaining = this.video.duration - this.video.currentTime;
            if (timeRemaining > 0.5 && this.video.paused) {
                this.video.play();
            }
        }

        // The landing point may itself be inside a segment (a manual one, say).
        this.aimPast(jumpTarget);

        this.requestAF(() => {
            const uniqueNames = [...new Set(skippedCategories)];
            const formattedName = uniqueNames.length === 1 ?
                uniqueNames[0] :
                uniqueNames.length === 2 ?
                `${uniqueNames[0]} and ${uniqueNames[1]}` :
                `${uniqueNames.slice(0, -1).join(', ')}, and ${uniqueNames[uniqueNames.length - 1]}`;

            showNotification(`Skipped ${formattedName} segment`);
        });

        this.log('info', `Skipped to ${jumpTarget}`);
    }

    // Auto Skip to Start: on a partly watched video YouTube's resume seek lands
    // right after a jump made at load and undoes it, so a seek away from the
    // highlight in the first few seconds is answered with one re-jump. A
    // segment skipped meanwhile (one right after the highlight) is no such seek.
    autoJumpToHighlight() {
        // Never Skip on These Channels: no jump by itself there either (Blue
        // still jumps). A channel not known yet: the jump waits for it.
        if (this.channelWhitelisted()) {
            if (!currentChannelName(this.videoID)) this.highlightPending = true;
            return;
        }
        if (!this.jumpToNextHighlight()) return;
        const video = this.video;
        const target = this.highlightSegment.segment[0];
        const until = Date.now() + 4000;
        this.ownSkipTarget = null;
        this._endHighlightGuard();
        const onSeeked = () => {
            // Ended too by the channel put on Never Skip on These Channels meanwhile.
            if (Date.now() > until || this.video !== video || this.isDestroyed || this.channelWhitelisted()) {
                this._endHighlightGuard();
            } else if (this.ownSkipTarget !== null && Math.abs(video.currentTime - this.ownSkipTarget) < 0.5) {
                // A skip of SponsorBlock's own. Kept, not used up: the skip
                // can start inside the highlight's own 'seeked' (a segment
                // that begins at the highlight), and its own 'seeked' follows.
            } else if (Math.abs(video.currentTime - target) > 2) {
                this._endHighlightGuard();
                video.currentTime = target;
            }
        };
        video.addEventListener('seeked', onSeeked);
        // Taken off when its window ends, also when no seek comes at all.
        const timer = setTimeout(() => this._endHighlightGuard(), 4000);
        this._highlightGuard = { video, onSeeked, timer };
    }

    /** Takes off autoJumpToHighlight's 'seeked' listener, if it is on. */
    _endHighlightGuard() {
        const guard = this._highlightGuard;
        if (!guard) return;
        this._highlightGuard = null;
        clearTimeout(guard.timer);
        guard.video.removeEventListener('seeked', guard.onSeeked);
    }

    /** The highlight's auto jump that waited for the video to load. */
    _jumpIfPending() {
        if (!this.highlightPending || !hasMedia(this.video)) return;
        this.highlightPending = false;
        // Switched away from Auto Skip to Start while it waited: no jump.
        if (configGetAll().sbMode_highlight === 'auto_skip') this.autoJumpToHighlight();
    }

    jumpToNextHighlight() {
        // An unplayable video ("This video isn't available") leaves the
        // <video> empty: no jump, and no toast saying it jumped.
        if (!hasMedia(this.video) || !this.highlightSegment) return false;

        const config = configGetAll();
        const mode = config.sbMode_highlight;
        if (!mode || mode === 'disable') return false;

        this.video.currentTime = this.highlightSegment.segment[0];
        this.requestAF(() => showNotification('Jumped to Highlight'));
        return true;
    }
    
    skipToPreviousSegment() {
    const list = this.backSegments || this.skipSegments;
    if (!this.video || !list.length) return false;

    const currentTime = this.video.currentTime;
    let targetSeg = null;

    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].start < currentTime - 2) {
            targetSeg = list[i];
            break;
        }
    }

    if (!targetSeg) return false;
    
    this.tempWhitelistIndex = targetSeg.originalIndex;
    this.video.currentTime = targetSeg.start;
    
    const categoryName = this.getCategoryName(targetSeg.category);
    const title = categoryName.charAt(0).toUpperCase() + categoryName.slice(1);
    
    this.requestAF(() => showNotification(`Seeked to ${title}`));
    return true;
    }

    handleBlueButton() {
        // An auto skip that landed where this manual segment starts (a chain
        // cut at it): Blue takes the skip back first, as the README says it
        // does within 8 s, and the manual segment is offered again on the way.
        const last = this.lastAutoSkip;
        const manual = this.currentManualSegment;
        if (last && manual && Math.abs(manual.start - last.to) < 0.5 && this.undoLastSkip()) {
            this.clearManualNotification();
            return true;
        }
        if (this.skipManualSegment()) return true;

        // Pressed just after an auto skip: the skip is taken back.
        if (this.undoLastSkip()) return true;
        return this.jumpToNextHighlight();
    }

    /** Skips the manual segment offered now, if any. */
    skipManualSegment() {
        if (this.currentManualSegment) {
            if (this.video) {
                this.isSkipping = true;
                this.lastSkipTime = this.video.currentTime;
                this.ownSkipTarget = this.currentManualSegment.end;
                const manualFrom = this.video.currentTime;
                const manualSeg = this.currentManualSegment;
                this.video.currentTime = manualSeg.end;
                this.noteSkip(manualFrom, manualSeg.end, [manualSeg.originalIndex]);
                // A skip asked for by hand is not taken back by the same key.
                this.lastAutoSkip = null;

                this.clearManualNotification();

                this.requestAF(() => showNotification('Skipped Segment'));

                setTimeout(() => { this.isSkipping = false; }, 500);
                return true;
            }
        }
        return false;
    }

    clearRefresh() {
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
        this.refreshPending = false;
    }

    scheduleRefresh() {
        this.clearRefresh();
        if (this.isDestroyed || !configGetAll().sbPeriodicRefresh) return;
        let delay;
        if (this.consecutiveFailures > 0) {
            delay = REFRESH_BACKOFF_MS[Math.min(this.consecutiveFailures, REFRESH_BACKOFF_MS.length) - 1];
        } else if (this.segments && this.segments.length > 0) {
            delay = REFRESH_POPULATED_MS;
        } else {
            delay = REFRESH_BACKOFF_MS[Math.min(Math.max(1, this.consecutiveEmptyChecks), REFRESH_BACKOFF_MS.length) - 1];
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            this.refreshSegments();
        }, delay);
    }

    async refreshSegments() {
        if (this.isDestroyed || this.refreshInFlight) return;
        const video = this.video || getVideo();
        // No fetching for a paused or backgrounded player; 'playing' picks it up.
        if (!video || video.paused) {
            this.refreshPending = true;
            return;
        }
        this.refreshPending = false;
        this.refreshInFlight = true;
        const videoID = this.videoID;
        try {
            const hash = sha256(videoID);
            const data = hash ? await this.fetchSegments(hash.substring(0, 4)) : null;
            if (this.isDestroyed || this.videoID !== videoID) return;
            if (data === null) {
                this.consecutiveFailures++;
                return;
            }
            this.consecutiveFailures = 0;
            const videoData = Array.isArray(data) ? data.find(x => x && x.videoID === videoID) : data;
            const segments = videoData && Array.isArray(videoData.segments) ? normalizeSegments(videoData.segments) : [];
            if (segments.length === 0) {
                this.consecutiveEmptyChecks++;
                return;
            }
            this.consecutiveEmptyChecks = 0;
            segments.sort((a, b) => a.segment[0] - b.segment[0]);
            const sig = segmentsSignature(segments);
            if (sig === this.segmentsSig) return;
            this.applyRefreshedSegments(segments, sig);
        } catch (e) {
            this.consecutiveFailures++;
            this.log('warn', 'Refresh failed', e);
        } finally {
            this.refreshInFlight = false;
            if (!this.isDestroyed) this.scheduleRefresh();
        }
    }

    /** Swaps in a changed segment list mid-video, keeping "skip once" memory by UUID. */
    applyRefreshedSegments(segments, sig) {
        const before = this.segments || [];
        const skippedUUIDs = new Set();
        if (this.skippedSegmentIndices) {
            this.skippedSegmentIndices.forEach(i => { if (before[i] && before[i].UUID) skippedUUIDs.add(before[i].UUID); });
            this.skippedSegmentIndices.clear();
            segments.forEach((s, i) => { if (s.UUID && skippedUUIDs.has(s.UUID)) this.skippedSegmentIndices.add(i); });
        }
        // The segment chosen to be watched ("skip to previous") is an index into
        // the list too: it follows its segment, or goes when that is gone.
        if (this.tempWhitelistIndex !== -1) {
            const chosen = before[this.tempWhitelistIndex];
            this.tempWhitelistIndex = chosen && chosen.UUID ? segments.findIndex(s => s.UUID === chosen.UUID) : -1;
        }
        // The community's chapters are no segments to announce.
        const skippable = (list) => list.filter(s => s.category !== 'chapter').length;
        const added = skippable(segments) - skippable(before);

        this.segments = segments;
        this.segmentsSig = sig;
        this.highlightSegment = this.segments.find(s => s.category === 'poi_highlight');
        if (!this.video) this.start();
        const video = this.video;
        if (video && video.duration && !isNaN(video.duration)) this.processSegments(video.duration);
        this.rebuildSkipSegments();
        this.updateSegmentList();
        // The first drawable segments of a video that had none start the bar watch.
        this._startBarWatch();
        this.lastOverlayHash = null;
        this.drawOverlay();
        this.updateLabels();
        this.log('info', `Segments updated (${before.length} -> ${segments.length})`);
        if (added > 0) showNotification(`SponsorBlock: ${added} new segment${added === 1 ? '' : 's'}`);
    }

    async fetchSegments(hashPrefix) {
        if (this.isDestroyed) return null;

        if (this.abortController) {
            this.abortController.abort();
        }
        // One controller for this call (both servers); destroy() aborts it.
        const controller = HAS_ABORT_CONTROLLER ? new AbortController() : null;
        this.abortController = controller;

        const tryFetch = async (url) => {
            if (this.isDestroyed || (controller && controller.signal.aborted)) return null;

            try {
                const fetchURL = `${url}/skipSegments/${hashPrefix}?categories=${FETCH_CATEGORIES}&actionTypes=${FETCH_ACTION_TYPES}`;

                // The deadline covers the body too: a server stalling
                // mid-answer used to hang here for good, so the fallback
                // server, the retries and the next refresh never ran.
                const res = await fetchJsonWithTimeout(fetchURL, SPONSORBLOCK_CONFIG.timeout,
                    controller ? { signal: controller.signal } : undefined);

                if (res.ok) return res.data;
                // 404 is the API saying it has nothing for this prefix - an
                // answer, not a failure worth retrying.
                return res.status === 404 ? [] : null;
            } catch (e) {
                if (!this.isDestroyed && e.name !== 'AbortError') {
                    this.log('warn', 'Fetch attempt failed:', e.message);
                }
                return null;
            }
        };

        let res = await tryFetch(SPONSORBLOCK_CONFIG.primaryAPI);
        if (!res) res = await tryFetch(SPONSORBLOCK_CONFIG.fallbackAPI);
        if (this.abortController === controller) this.abortController = null;
        return res;
    }

    addEvent(elem, type, handler) {
        if (!elem) return;
        elem.addEventListener(type, handler);
        if (!this.listeners.has(elem)) this.listeners.set(elem, new Map());
        this.listeners.get(elem).set(type, handler);
    }

    destroy() {
        this.isDestroyed = true;
        this.log('info', 'Destroying instance.');
        this.clearRefresh();
        this._endHighlightGuard();
        if (this.channelRetryTimer) {
            clearTimeout(this.channelRetryTimer);
            this.channelRetryTimer = null;
        }
        this.clearUndone();

        this.toggleTimeListener(false);
        
        if (this.boundStateChange) {
            window.removeEventListener('yt-player-state-change', this.boundStateChange);
            this.boundStateChange = null;
        }

        if (this.boundProfileChange) {
            window.removeEventListener('ytaf-profile-change', this.boundProfileChange);
            this.boundProfileChange = null;
        }

        if (this.boundResize) {
            window.removeEventListener('resize', this.boundResize);
            this.boundResize = null;
        }

        this.rafIds.forEach(id => { cancelAnimationFrame(id); });
        this.rafIds.clear();
        this.stopHighFreqLoop();

        if (this.chainSkipVideo) {
            if (this.boundChainSkipRetry) {
                this.chainSkipVideo.removeEventListener('loadedmetadata', this.boundChainSkipRetry);
            }
        }
        this.boundChainSkipRetry = null;
        this.chainSkipVideo = null;

        window.__sb_pending_unmute = false;
        this.leaveMutedSegment();

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        this.clearManualNotification();
        this._clearSkipWatchdog();
        if (this._barRetryTimer) {
            clearInterval(this._barRetryTimer);
            this._barRetryTimer = null;
        }
        if (this._measureTimer) {
            clearInterval(this._measureTimer);
            this._measureTimer = null;
        }
        this._observedRoot = null;
        this._stopVideoWait();

        sponsorBlockUI.togglePopup(false);
        sponsorBlockUI.updateSegments([]);
        sponsorBlockLabels.clear();
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        // sponsorblock.css stays in the page (static import) — nothing to
        // remove. It only styles elements that exist while SB is active.

        this.listeners.forEach((events, elem) => {
            events.forEach((handler, type) => { elem.removeEventListener(type, handler); });
        });
        this.listeners.clear();

        this.observers.forEach(obs => { obs.disconnect(); });
        this.observers.clear();

        this.configListeners.forEach(({ key, callback }) => {
            configRemoveChangeListener(key, callback);
        });
        this.configListeners = [];

        this.segments = [];
        this.skipSegments = [];
        this.video = null;
        this.progressBar = null;
        this.tempWhitelistIndex = -1;

        if (this.skippedSegmentIndices) {
            this.skippedSegmentIndices.clear();
            this.skippedSegmentIndices = null;
        }
    }
}

if (typeof window !== 'undefined') {
    if (window.__ytaf_sb_init) {
        window.removeEventListener('hashchange', window.__ytaf_sb_init);
        configRemoveChangeListener('enableSponsorBlock', window.__ytaf_sb_init);
    }

    window.sponsorblock = null;
    let initTimeout = null;

    const initSB = () => {
        // A hash change within the same video keeps the handler: its segments
        // and what Skip Segments Once remembers stay.
        const current = window.sponsorblock;
        if (current && !current.isDestroyed && configGetAll().enableSponsorBlock &&
            current.videoID === videoIdFromHash()) return;

        if (window.sponsorblock) {
            window.sponsorblock.destroy();
            window.sponsorblock = null;
        }
        if (initTimeout) clearTimeout(initTimeout);

        const run = () => {
            const videoID = videoIdFromHash();
            const config = configGetAll();
            if (videoID && config.enableSponsorBlock) {
                window.sponsorblock = new SponsorBlockHandler(videoID);
                window.sponsorblock.init();
            }
            initTimeout = null;
        };

        initTimeout = setTimeout(run, 10);
    };

    window.__ytaf_sb_init = initSB;
    window.addEventListener('hashchange', initSB);
    // The switch applies at once, not from the next video.
    configAddChangeListener('enableSponsorBlock', initSB);

    if (document.readyState !== 'loading') {
        setTimeout(initSB, 500);
    } else {
        window.addEventListener('load', () => setTimeout(initSB, 500), { once: true });
    }
}
