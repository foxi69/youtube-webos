/**
 * Search: Upload Date (hooks/json-stringify.ts): an InnerTube search body
 * with no params of its own gets the chosen upload date filter, on a copy;
 * one that carries params, other request bodies and Any Time are left alone,
 * and player requests still get isInlinePlaybackNoAd.
 *
 * Usage: node bench/search-filter-test.cjs [bundle] [legacy|modern]
 */
const { createReporter, bootPage } = require('./harness.cjs');

const { t, done } = createReporter();

// The bundle of the command line: `modern` is the modern one (webOS 22 and
// newer), in a Chrome 87 environment with a webOS 23 user agent, instead of
// the legacy one in a Chrome 38 one. Only page script errors are collected,
// and the environment is left without Element#remove.
function boot(searchUploadDate, enableAdBlock = true) {
  const { win, errors } = bootPage({
    bodyClass: 'WEB_PAGE_TYPE_SEARCH',
    config: {
      enableAdBlock, enableLegacyEmojiFix: false, enableSponsorBlock: false,
      enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false,
      searchUploadDate
    },
    consoleErrors: false,
    restoreRemove: false
  });
  return { win, errors, send: (body) => JSON.parse(win.JSON.stringify(body)) };
}

const context = { client: { clientName: 'TVHTML5', clientVersion: '7.20250101.00.00' } };

{
  const { send } = boot('week', false);
  t('Ad Blocking off: the search still gets the week filter', send({ context, query: 'nasa' }).params === 'EgIIAw==');
}

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

done();
