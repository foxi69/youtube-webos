/**
 * Behaviour test for src/heatmap-data.js (the "most replayed" lookup behind
 * Show Most Replayed Graph Above the Seek Bar). No live network: a
 * controllable XMLHttpRequest and clock stand in for both. The fixture is a
 * trimmed copy of a real /youtubei/v1/next answer with the request's
 * `fields` mask (dQw4w9WgXcQ, 2026-10): one mutation without a payload, as
 * the real answer has, then the heatmap list.
 *
 * Usage: node bench/most-replayed-test.cjs
 */
/* global __dirname */
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = pathToFileURL(path.join(ROOT, 'src/heatmap-data.js')).href;

let clock = 1700000000000;
Date.now = () => clock;

const xhrs = [];
class FakeXHR {
  constructor() {
    this.headers = {};
    this.status = 0;
    this.responseText = '';
    xhrs.push(this);
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send(body) { this.body = body; }
  abort() {}
}
globalThis.XMLHttpRequest = FakeXHR;

const respond = (x, status, body) => {
  x.status = status;
  x.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  x.onload();
};
const flush = () => new Promise((r) => setImmediate(r));

const NEW_SHAPE = {
  playerOverlays: { playerOverlayRenderer: { decoratedPlayerBarRenderer: { decoratedPlayerBarRenderer: { playerBar: { multiMarkersPlayerBarRenderer: {} } } } } },
  frameworkUpdates: { entityBatchUpdate: { mutations: [
    {},
    { payload: { macroMarkersListEntity: { markersList: { markerType: 'MARKER_TYPE_CHAPTERS', markers: [] } } } },
    { payload: { macroMarkersListEntity: { markersList: {
      markerType: 'MARKER_TYPE_HEATMAP',
      markers: [
        { startMillis: '2140', durationMillis: '2140', intensityScoreNormalized: 0.42303155493404082 },
        { startMillis: '0', durationMillis: '2140', intensityScoreNormalized: 1 },
        { startMillis: '4280', durationMillis: '2140', intensityScoreNormalized: 0.35330354918098361 }
      ]
    } } } }
  ] } }
};

const OLD_SHAPE = {
  playerOverlays: { playerOverlayRenderer: { decoratedPlayerBarRenderer: { decoratedPlayerBarRenderer: { playerBar: { multiMarkersPlayerBarRenderer: {
    markersMap: [
      { key: 'DESCRIPTION_CHAPTERS', value: { chapters: [] } },
      { key: 'HEATSEEKER', value: { heatmap: { heatmapRenderer: { heatMarkers: [
        { heatMarkerRenderer: { timeRangeStartMillis: 0, markerDurationMillis: 5000, heatMarkerIntensityScoreNormalized: 0.2 } },
        { heatMarkerRenderer: { timeRangeStartMillis: 5000, markerDurationMillis: 5000, heatMarkerIntensityScoreNormalized: 1.5 } }
      ] } } } }
    ]
  } } } } } }
};

let pass = 0, fail = 0;
const t = (n, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + n); }
  else { fail++; console.log('FAIL ' + n + (extra ? '\n     ' + extra : '')); }
};

let generation = 0;
const fresh = async () => {
  xhrs.length = 0;
  return import(SERVICE + '?case=' + (generation++));
};

async function main() {
  let m = await fresh();

  // ---- parsing ----
  const a = m.parseHeatmap(NEW_SHAPE);
  t('current shape: three markers, sorted, in seconds',
    a && a.length === 3 && a[0].start === 0 && a[0].value === 1 && a[1].start === 2.14 && a[2].duration === 2.14,
    JSON.stringify(a));
  const b = m.parseHeatmap(OLD_SHAPE);
  t('older markersMap shape, value clamped to 1',
    b && b.length === 2 && b[0].value === 0.2 && b[1].value === 1 && b[1].start === 5, JSON.stringify(b));
  t('no heatmap: null', m.parseHeatmap({ frameworkUpdates: { entityBatchUpdate: { mutations: [{}] } } }) === null);
  t('garbage: null', m.parseHeatmap(null) === null && m.parseHeatmap('x') === null && m.parseHeatmap({}) === null);
  t('a single marker is no graph', m.parseHeatmap(OLD_SHAPE.playerOverlays && {
    frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: { macroMarkersListEntity: { markersList: {
      markerType: 'MARKER_TYPE_HEATMAP', markers: [{ startMillis: '0', durationMillis: '10', intensityScoreNormalized: 1 }] } } } }] } }
  }) === null);

  // ---- graph ----
  const d = m.buildHeatmapPath(a);
  t('path starts at the bottom-left and closes along the bottom', /^M0,100L0,0L/.test(d) && /L1000,100Z$/.test(d), d);
  t('path has one smoothing segment per gap', (d.match(/Q/g) || []).length === 2, d);
  t('path spans 0-1000 only', d.split(/[^\d.-]+/).filter(Boolean).every((n) => +n >= 0 && +n <= 1000), d);
  const uri = m.buildHeatmapUri(a, 6.42);
  t('uri is an SVG data URI without raw quotes or spaces',
    uri.indexOf('data:image/svg+xml,') === 0 && !/["' ]/.test(uri.slice(19)), uri.slice(0, 80));
  t('no markers, no graph', m.buildHeatmapUri(null) === '' && m.buildHeatmapPath([]) === '');

  // ---- lookup ----
  let got = m.getHeatmap('dQw4w9WgXcQ');
  const again = m.getHeatmap('dQw4w9WgXcQ');
  t('one request for two callers', xhrs.length === 1 && got === again);
  const x = xhrs[0];
  t('POST to /next with the fields mask', x.method === 'POST' && x.url.indexOf('/youtubei/v1/next?prettyPrint=false&fields=') === 0 &&
    decodeURIComponent(x.url).indexOf('macroMarkersListEntity.markersList') !== -1);
  const body = JSON.parse(x.body);
  t('WEB client, the video id', body.videoId === 'dQw4w9WgXcQ' && body.context.client.clientName === 'WEB');
  respond(x, 200, NEW_SHAPE);
  const r = await got;
  t('answer parsed', r && r.length === 3);
  got = await m.getHeatmap('dQw4w9WgXcQ');
  t('answer cached', xhrs.length === 1 && got && got.length === 3);

  t('bad id: no request', (await m.getHeatmap('nope')) === null && xhrs.length === 1);

  m = await fresh();
  got = m.getHeatmap('aaaaaaaaaaa');
  respond(xhrs[0], 200, { frameworkUpdates: { entityBatchUpdate: { mutations: [{}] } } });
  t('no heatmap resolves null', (await got) === null);
  await m.getHeatmap('aaaaaaaaaaa');
  t('"no heatmap" is kept', xhrs.length === 1);

  got = m.getHeatmap('bbbbbbbbbbb');
  respond(xhrs[1], 500, '');
  t('HTTP error resolves null', (await got) === null);
  await m.getHeatmap('bbbbbbbbbbb');
  t('failure not retried at once', xhrs.length === 2);
  clock += 61000;
  m.getHeatmap('bbbbbbbbbbb');
  t('failure retried after a minute', xhrs.length === 3);
  xhrs[2].onerror();
  await flush();

  got = m.getHeatmap('ccccccccccc');
  respond(xhrs[3], 200, 'not json');
  t('bad JSON resolves null', (await got) === null);

  got = m.getHeatmap('ddddddddddd');
  xhrs[4].ontimeout();
  t('timeout resolves null', (await got) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
