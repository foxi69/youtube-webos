/**
 * "Most replayed" data for a video (NicholasBly/youtube-webos#211).
 *
 * The TV client's own responses do not carry it; the WEB watch page
 * (`/youtubei/v1/next`) does, like the AI label in youtube-ai-label.js. Two
 * shapes are read:
 *   - frameworkUpdates...macroMarkersListEntity.markersList with markerType
 *     MARKER_TYPE_HEATMAP (current), markers {startMillis, durationMillis,
 *     intensityScoreNormalized};
 *   - the older decoratedPlayerBarRenderer markersMap entry whose value has a
 *     heatmapRenderer, markers {timeRangeStartMillis, markerDurationMillis,
 *     heatMarkerIntensityScoreNormalized}.
 * The `fields` mask keeps the answer to those two parts (about 10 kB).
 *
 * Results: an array of { start, duration, value } (seconds, seconds, 0-1),
 * sorted by start, or null when the video has none (new or little-watched
 * videos, live streams) or the lookup failed. Never rejects.
 */

const VIDEO_ID_RE = /^[\w-]{11}$/;
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_MAX = 50;
// A failed lookup is retried after this long; "no heatmap" is kept as an answer.
const FAILURE_TTL_MS = 60000;

const FIELDS =
  'frameworkUpdates.entityBatchUpdate.mutations.payload.macroMarkersListEntity.markersList,' +
  'playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer.markersMap';
export const REQUEST_URL = '/youtubei/v1/next?prettyPrint=false&fields=' + encodeURIComponent(FIELDS);

// videoId -> { markers, expiresAt } (expiresAt Infinity for real answers).
// Insertion order is recency order.
const cache = new Map();
const pending = new Map();

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : NaN;
}

function normalise(list, startKey, durKey, valueKey) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object') continue;
    const start = num(m[startKey]);
    const duration = num(m[durKey]);
    const value = num(m[valueKey]);
    if (!(start >= 0) || !(duration > 0) || isNaN(value)) continue;
    out.push({ start: start / 1000, duration: duration / 1000, value: Math.max(0, Math.min(1, value)) });
  }
  if (out.length < 2) return null;
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** The heatmap markers in a parsed `next` response, or null. */
export function parseHeatmap(data) {
  if (!data || typeof data !== 'object') return null;

  const mutations = data.frameworkUpdates && data.frameworkUpdates.entityBatchUpdate &&
    data.frameworkUpdates.entityBatchUpdate.mutations;
  if (Array.isArray(mutations)) {
    for (let i = 0; i < mutations.length; i++) {
      const entity = mutations[i] && mutations[i].payload && mutations[i].payload.macroMarkersListEntity;
      const list = entity && entity.markersList;
      if (!list || list.markerType !== 'MARKER_TYPE_HEATMAP') continue;
      const markers = normalise(list.markers, 'startMillis', 'durationMillis', 'intensityScoreNormalized');
      if (markers) return markers;
    }
  }

  const bar = data.playerOverlays && data.playerOverlays.playerOverlayRenderer &&
    data.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer &&
    data.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer &&
    data.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar &&
    data.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer;
  const map = bar && bar.markersMap;
  if (Array.isArray(map)) {
    for (let i = 0; i < map.length; i++) {
      const renderer = map[i] && map[i].value && map[i].value.heatmap && map[i].value.heatmap.heatmapRenderer;
      if (!renderer || !Array.isArray(renderer.heatMarkers)) continue;
      const list = renderer.heatMarkers.map((h) => h && h.heatMarkerRenderer);
      const markers = normalise(list, 'timeRangeStartMillis', 'markerDurationMillis', 'heatMarkerIntensityScoreNormalized');
      if (markers) return markers;
    }
  }
  return null;
}

function remember(id, markers, expiresAt) {
  cache.delete(id);
  cache.set(id, { markers, expiresAt });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function lookup(id) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (markers, ok) => {
      if (settled) return;
      settled = true;
      remember(id, markers, ok ? Infinity : Date.now() + FAILURE_TTL_MS);
      resolve(markers);
    };
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', REQUEST_URL, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = REQUEST_TIMEOUT_MS;
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) return done(null, false);
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          return done(null, false);
        }
        done(parseHeatmap(data), true);
      };
      xhr.onerror = () => done(null, false);
      xhr.ontimeout = () => done(null, false);
      xhr.send(JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20250601.01.00', hl: 'en' } },
        videoId: id
      }));
    } catch {
      done(null, false);
    }
  });
}

/**
 * @param {string} videoId
 * @returns {Promise<Array<{start: number, duration: number, value: number}>|null>}
 */
export function getHeatmap(videoId) {
  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return Promise.resolve(null);

  const cached = cache.get(videoId);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      cache.delete(videoId);
      cache.set(videoId, cached);
      return Promise.resolve(cached.markers);
    }
    cache.delete(videoId);
  }

  const inFlight = pending.get(videoId);
  if (inFlight) return inFlight;

  const promise = lookup(videoId).then((markers) => {
    pending.delete(videoId);
    return markers;
  });
  pending.set(videoId, promise);
  return promise;
}

const r1 = (n) => Math.round(n * 10) / 10;

/**
 * The graph as an SVG path in a 1000 x 100 box (x along the video, y down):
 * a curve through the middle of each marker, smoothed with quadratic
 * segments between midpoints, closed along the bottom edge. `total` is the
 * length the bar stands for; it defaults to the end of the last marker.
 */
export function buildHeatmapPath(markers, total) {
  if (!Array.isArray(markers) || markers.length < 2) return '';
  const last = markers[markers.length - 1];
  const length = total > 0 ? total : last.start + last.duration;
  if (!(length > 0)) return '';

  const pts = [];
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const x = Math.max(0, Math.min(1000, ((m.start + m.duration / 2) / length) * 1000));
    pts.push([x, 100 - m.value * 100]);
  }
  // Flat to both edges, so the graph spans the whole bar.
  const first = pts[0];
  const end = pts[pts.length - 1];
  let d = `M0,100L0,${r1(first[1])}L${r1(first[0])},${r1(first[1])}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    d += `Q${r1(p[0])},${r1(p[1])} ${r1((p[0] + q[0]) / 2)},${r1((p[1] + q[1]) / 2)}`;
  }
  d += `L${r1(end[0])},${r1(end[1])}L1000,${r1(end[1])}L1000,100Z`;
  return d;
}

/** A data: URI of the graph, for a CSS background, or '' when there is none. */
export function buildHeatmapUri(markers, total) {
  const d = buildHeatmapPath(markers, total);
  if (!d) return '';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 100" preserveAspectRatio="none">' +
    `<path d="${d}" fill="#fff" fill-opacity="0.35" stroke="#fff" stroke-opacity="0.6" stroke-width="2" vector-effect="non-scaling-stroke"/>` +
    '</svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
