/**
 * The app language fix (lang-settings-fix.ts, from TizenTube): choosing a
 * language in YouTube's settings is caught at the TV app's command resolver,
 * the language goes into the PREF cookie (hl=) and the page reloads in it.
 * feed-features-test and page-bridge-test cover a first choice and a missing
 * language; this test covers the cookie YouTube already has (its other
 * preferences kept, an earlier language replaced, the cookie's domain and
 * lifetime), and the settings commands the fix must hand to the app as they
 * are: another setting, and shapes it does not know.
 *
 *   node bench/lang-settings-fix-test.cjs <bundle> [legacy|modern]
 *
 * The TV app's resolver is a stand-in in window._yttv that records what
 * reaches it.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();
const URL = 'https://www.youtube.com/tv';
const YEAR = 365 * 24 * 3600 * 1000;

const { t, run } = createReporter();

async function boot(opts = {}) {
  const warnings = [];
  const { win, dom, errors, evaluate } = bootPage({
    code,
    url: URL,
    console: { warn: (...a) => warnings.push(a.map(String).join(' ')) },
    config: {
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, enableLegacyEmojiFix: false
    },
    fetch: 'pending',
    evaluate: false
  });
  // YouTube's own cookies, as the page has them before the bundle.
  for (const c of opts.cookies || []) dom.cookieJar.setCookieSync(c, URL);
  const seen = [];
  const Resolver = function Resolver() {};
  Resolver.instance = { resolveCommand: (command, extra) => { seen.push({ command, extra }); return 'app'; } };
  win._yttv = { resolver: Resolver };
  evaluate();
  await wait(30);
  const resolve = Resolver.instance.resolveCommand;
  const pref = () => {
    const c = dom.cookieJar.getCookiesSync(URL).find((x) => x.key === 'PREF');
    return c || null;
  };
  return { win, errors, warnings, seen, resolve, pref, cookies: () => win.document.cookie };
}

const language = (lang) => ({ setClientSettingEndpoint: { settingDatas: [
  { clientSettingEnum: { item: 'I18N_REGION' }, stringValue: 'HU' },
  { clientSettingEnum: { item: 'I18N_LANGUAGE' }, stringValue: lang }
] } });

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- YouTube's PREF cookie already there ----
  {
    const h = await boot({ cookies: ['PREF=f6=40000000&tz=Europe.Budapest&hl=en; Domain=.youtube.com; Path=/'] });
    const out = h.resolve(language('de'));
    const prefs = new URLSearchParams((h.pref() || {}).value || '');
    t(n('the chosen language replaces the earlier one in PREF'), prefs.get('hl') === 'de' && prefs.getAll('hl').length === 1,
      h.cookies());
    t(n('...and YouTube\'s other preferences in it stay'), prefs.get('f6') === '40000000' && prefs.get('tz') === 'Europe.Budapest',
      h.cookies());
    t(n('...one PREF cookie, not a second one beside it'), (h.cookies().match(/(?:^|; )PREF=/g) || []).length === 1, h.cookies());
    const c = h.pref();
    t(n('the cookie is for all of youtube.com'), c && c.domain === 'youtube.com' && !c.hostOnly, c && c.domain);
    const left = c && c.expires instanceof Date ? c.expires.getTime() - Date.now() : 0;
    t(n('...and lasts ten years'), left > 9.9 * YEAR && left < 10.1 * YEAR, c && String(c.expires));
    t(n('the page is reloaded in the new language, the choice itself not passed on'),
      out === true && h.seen.length === 1 && JSON.stringify(h.seen[0].command) === '{"signalAction":{"signal":"RELOAD_PAGE"}}',
      JSON.stringify(h.seen));
    t(n('cookie: no warnings, no page errors'), !h.warnings.some((w) => /lang-settings-fix/.test(w)) && h.errors.length === 0,
      h.warnings.concat(h.errors).join(' | '));
  }

  // ---- Other cookies only ----
  {
    const h = await boot({ cookies: ['VISITOR_INFO1_LIVE=abc; Domain=.youtube.com; Path=/'] });
    h.resolve(language('fr'));
    const c = h.pref();
    t(n('no PREF yet: one is made with the language'), c && c.value === 'hl=fr', h.cookies());
    t(n('...and that new cookie is for all of youtube.com too'), c && c.domain === 'youtube.com' && !c.hostOnly, c && c.domain);
    t(n('...the other cookies left as they are'), /VISITOR_INFO1_LIVE=abc/.test(h.cookies()), h.cookies());
  }

  // ---- What goes to the app untouched ----
  {
    const h = await boot();
    const other = { setClientSettingEndpoint: { settingDatas: [{ clientSettingEnum: { item: 'I18N_REGION' }, stringValue: 'HU' }] } };
    const out = h.resolve(other, { from: 'settings' });
    t(n('another setting goes to the app as it is, with its extra'),
      out === 'app' && h.seen.length === 1 && h.seen[0].command === other && h.seen[0].extra.from === 'settings', JSON.stringify(h.seen));
    t(n('...without a warning, and no cookie'), !h.warnings.some((w) => /lang-settings-fix/.test(w)) && h.pref() === null,
      h.warnings.join(' | '));

    const odd = [
      ['no endpoint body', { setClientSettingEndpoint: null }],
      ['an endpoint that is not an object', { setClientSettingEndpoint: 'I18N_LANGUAGE' }],
      ['settings that are not a list', { setClientSettingEndpoint: { settingDatas: { clientSettingEnum: { item: 'I18N_LANGUAGE' }, stringValue: 'de' } } }]
    ];
    for (const [what, command] of odd) {
      h.seen.length = 0;
      h.warnings.length = 0;
      const r = h.resolve(command, 'extra');
      t(n(`${what}: handed to the app as it is`), r === 'app' && h.seen.length === 1 && h.seen[0].command === command &&
        h.seen[0].extra === 'extra', JSON.stringify(h.seen));
      t(n(`${what}: with a warning`), h.warnings.some((w) => /\[lang-settings-fix\] Passing through/.test(w)), h.warnings.join(' | '));
    }
    t(n('nothing odd set a cookie'), h.pref() === null, h.cookies());
    t(n('untouched: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }
});
