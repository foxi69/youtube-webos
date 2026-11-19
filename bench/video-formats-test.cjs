/**
 * Skip AI-Upscaled Qualities and Force Max Quality's "Up to" limit: the video
 * formats they drop from a player response, the ones they keep, and the panel
 * row that sets Force Max Quality with its limit.
 *
 * Usage: node bench/video-formats-test.cjs [dist/webOSUserScripts/userScript.js] [legacy|modern]
 */
const { createReporter, bootPage, trustedKey, wait, UA } = require('./harness.cjs');

const pad = 'z'.repeat(600);

function boot(cfg) {
  let NS;
  const { win } = bootPage({
    bodyClass: 'WEB_PAGE_TYPE_BROWSE',
    userAgent: UA.webos23,
    launchParams: '{}',
    raf: 'manual',
    config: Object.assign({
      enableAdBlock: true, enableLegacyEmojiFix: false, enableSponsorBlock: false,
      enableReturnYouTubeDislike: false, thumbnailQuality: 'off', enableAutoLogin: false
    }, cfg),
    consoleErrors: false,
    restoreRemove: false,
    setup: (w) => { NS = w.JSON.stringify; },
    fetch: () => Promise.reject(new Error('offline'))
  });
  const parse = (obj) => win.JSON.parse(NS(obj));
  return { win, parse };
}

const { t, run } = createReporter();

const b64url = (str) => Buffer.from(str, 'latin1').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// The xtags YouTube sends on a "Super resolution" format, and the same pair with another tag before it.
const SR = 'CgcKAnNyEgEx';
const SR_AFTER_OTHER = b64url('\n\u0009\n\u0002ab\u0012\u0003xyz' + '\n\u0007\n\u0002sr\u0012\u00011');
const NOT_SR = b64url('\n\u0007\n\u0002sr\u0012\u00010');

const video = (itag, w, h, xtags) => {
  const f = { itag, mimeType: 'video/webm; codecs="vp9"', width: w, height: h, qualityLabel: Math.min(w, h) + 'p' };
  if (xtags) f.xtags = xtags;
  return f;
};
const audio = { itag: 251, mimeType: 'audio/webm; codecs="opus"' };
const player = (formats) => ({ responseContext: { _pad: pad }, streamingData: { adaptiveFormats: formats } });
const itags = (r) => r.streamingData.adaptiveFormats.map((f) => f.itag).join(',');

const list = () => [video(401, 3840, 2160, SR), video(400, 2560, 1440), video(399, 1920, 1080), video(398, 1280, 720), audio];

run(async () => {
  // ---- Skip AI-Upscaled Qualities ----
  {
    const { parse } = boot({ removeUpscaledFormats: true });
    t('upscaled: the "Super resolution" format is dropped, the rest stay',
      itags(parse(player(list()))) === '400,399,398,251', itags(parse(player(list()))));
    t('upscaled: the sr=1 pair is found beside another tag',
      itags(parse(player([video(401, 3840, 2160, SR_AFTER_OTHER), video(399, 1920, 1080), audio]))) === '399,251');
    t('upscaled: sr=0 is no upscale',
      itags(parse(player([video(401, 3840, 2160, NOT_SR), video(399, 1920, 1080), audio]))) === '401,399,251');
    t('upscaled: a video with only upscaled formats keeps them',
      itags(parse(player([video(401, 3840, 2160, SR), audio]))) === '401,251');
    const wrapped = parse({ responseContext: { _pad: pad }, playerResponse: player(list()), contents: { singleColumnWatchNextResults: {} } });
    t('upscaled: a playerResponse inside a watch response', itags(wrapped.playerResponse) === '400,399,398,251', itags(wrapped.playerResponse));
    t('upscaled: on with Ad Blocking off too',
      itags(boot({ removeUpscaledFormats: true, enableAdBlock: false }).parse(player(list()))) === '400,399,398,251');

    const off = boot({ removeUpscaledFormats: false });
    t('upscaled off: nothing dropped', itags(off.parse(player(list()))) === '401,400,399,398,251');
  }

  // ---- Force Max Quality: Up to ----
  {
    const capped = boot({ forceHighResVideo: true, maxVideoQuality: '1080', removeUpscaledFormats: false });
    t('up to 1080p: the formats above it go, audio stays',
      itags(capped.parse(player(list()))) === '399,398,251', itags(capped.parse(player(list()))));
    t('up to 1080p: a vertical 1080x1920 counts as 1080p',
      itags(capped.parse(player([video(299, 1080, 1920), video(298, 720, 1280), audio]))) === '299,298,251');
    t('up to 1080p: only the label to go by',
      itags(capped.parse(player([{ itag: 1, mimeType: 'video/mp4', qualityLabel: '1440p60' }, { itag: 2, mimeType: 'video/mp4', qualityLabel: '1080p60' }]))) === '2');
    t('up to 480p: a video with nothing that small keeps its formats',
      itags(boot({ forceHighResVideo: true, maxVideoQuality: '480' }).parse(player([video(399, 1920, 1080), video(398, 1280, 720), audio]))) === '399,398,251');
    t('Max: no limit',
      itags(boot({ forceHighResVideo: true, maxVideoQuality: '0', removeUpscaledFormats: false }).parse(player(list()))) === '401,400,399,398,251');
    t('a stored limit does nothing while Force Max Quality is off',
      itags(boot({ forceHighResVideo: false, maxVideoQuality: '720', removeUpscaledFormats: false }).parse(player(list()))) === '401,400,399,398,251');
    t('both: the upscaled format and the ones above the limit',
      itags(boot({ forceHighResVideo: true, maxVideoQuality: '1440', removeUpscaledFormats: true }).parse(player(list()))) === '400,399,398,251');
  }

  // ---- The panel row ----
  {
    const { win } = boot({ forceHighResVideo: false, maxVideoQuality: '0' });
    trustedKey(win, 404, win.document.body, 'keydown');
    trustedKey(win, 404, win.document.body, 'keyup');
    await wait(300);
    const rows = Array.prototype.slice.call(win.document.querySelectorAll('.shortcut-control-row'));
    const row = rows.find((r) => (r.querySelector('.shortcut-label') || {}).textContent.trim() === 'Force Max Quality');
    const value = () => row.querySelector('.current-value').textContent;
    const stored = () => {
      const c = JSON.parse(win.localStorage.getItem('ytaf-configuration') || '{}');
      return c.forceHighResVideo + '/' + c.maxVideoQuality;
    };
    const press = (code) => { row.focus(); trustedKey(win, code, row, 'keydown'); trustedKey(win, code, row, 'keyup'); };
    const right = () => press(39);
    const left = () => press(37);
    t('panel: Force Max Quality is a choice row starting at Off', !!row && value() === 'Off', row ? value() : 'no row');
    if (row) {
      right(); await wait(260);
      t('panel: Right picks Max', value() === 'Max' && stored() === 'true/0', value() + ' ' + stored());
      right(); right(); right(); await wait(260);
      t('panel: then Up to 1080p', value() === 'Up to 1080p' && stored() === 'true/1080', value() + ' ' + stored());
      left(); left(); left(); left(); await wait(260);
      t('panel: Left back to Off clears the limit', value() === 'Off' && stored() === 'false/0', value() + ' ' + stored());
      left(); await wait(260);
      t('panel: Left from Off goes round to Up to 480p', value() === 'Up to 480p' && stored() === 'true/480', value() + ' ' + stored());
    }
  }
});
