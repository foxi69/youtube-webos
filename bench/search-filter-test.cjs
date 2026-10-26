/**
 * Search: Upload Date (hooks/json-stringify.ts): an InnerTube search body
 * with no params of its own gets the chosen upload date filter, on a copy;
 * one that carries params, other request bodies and Any Time are left alone,
 * and player requests still get isInlinePlaybackNoAd.
 *
 * Usage: node bench/search-filter-test.cjs [dist/webOSUserScripts/userScript.js]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const bundlePath = process.argv[2] || 'dist/webOSUserScripts/userScript.js';

function boot(searchUploadDate) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body class="WEB_PAGE_TYPE_SEARCH"><ytlr-app></ytlr-app></body></html>',
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, UA.webos3);
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open(){} send(){} setRequestHeader(){} getResponseHeader(){return null;} addEventListener(){} };
  win.localStorage.setItem('ytaf-configuration', win.JSON.stringify({
    enableAdBlock: false, enableLegacyEmojiFix: false, enableSponsorBlock: false,
    enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false,
    searchUploadDate
  }));
  applyChrome38Downgrade(win);
  win.eval(fs.readFileSync(bundlePath, 'utf8'));
  return { win, errors, send: (body) => JSON.parse(win.JSON.stringify(body)) };
}

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '\n     ' + extra : '')); }
};
const context = { client: { clientName: 'TVHTML5', clientVersion: '7.20250101.00.00' } };

{
  const { send, errors } = boot('week');
  const search = { context, query: 'nasa' };
  const sent = send(search);
  t('This Week: the search gets the week filter', sent.params === 'EgIIAw==', JSON.stringify(sent));
  t('the query and context go out unchanged', sent.query === 'nasa' && sent.context.client.clientName === 'TVHTML5');
  t("YouTube's own object is not written", !('params' in search));

  const channel = send({ context, query: 'nasa', params: 'EgZzZWFyY2g=', browseId: 'UC123' });
  t('a request with params of its own is left alone', channel.params === 'EgZzZWFyY2g=', JSON.stringify(channel));

  const next = send({ context, continuation: 'abc' });
  t('a continuation (no query) is left alone', !('params' in next));

  t('a body without context is left alone', !('params' in send({ query: 'local storage value' })));

  const player = send({ context, videoId: 'x', playbackContext: { contentPlaybackContext: { html5Preference: 'x' } } });
  t('player requests still get isInlinePlaybackNoAd',
    player.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd === true && !('params' in player));
  t('no page errors', errors.length === 0, errors.join(' | '));
}
{
  const { send } = boot('today');
  t('Today: the today filter', send({ context, query: 'nasa' }).params === 'EgIIAg==');
}
{
  const { send } = boot('any');
  t('Any Time: no filter', !('params' in send({ context, query: 'nasa' })));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
