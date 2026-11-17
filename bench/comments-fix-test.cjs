/**
 * The comments panel fix (comments-fix.js, NicholasBly/youtube-webos#188),
 * against the stylesheets it looks for. YouTube's CSS for the panel's closing
 * class collapses the panel to 0x0 while the list still measures its rows, so
 * the rows come back 0 tall on the next open; the fix finds those rules and
 * keeps the panel laid out but invisible. Until this test nothing ran it with
 * a collapsing rule on the page: where the rule is found (a plain sheet, an
 * @media block, a constructed sheet, behind a cross-origin one), which rules
 * are left alone, the fallback, the scan on panel focus and its limit, and
 * the startup retry that finds YouTube's CSS when it arrives late.
 *
 *   node bench/comments-fix-test.cjs <bundle> [legacy|modern]
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();

const { t, run } = createReporter();

// The panel as YouTube draws it: the overlay with its closing class, the
// panel's content box and a comment row in it.
const PANEL = `<ytlr-animated-overlay class="frHKed"><div class="AmQJbe">
  <ytlr-engagement-panel-section-list-renderer><div class="row" tabindex="0">A comment</div>
  </ytlr-engagement-panel-section-list-renderer></div></ytlr-animated-overlay>
  <button id="elsewhere" tabindex="0">Home</button>`;
const OVERLAY_SEL = 'ytlr-animated-overlay.frHKed .AmQJbe';

/** The bundle on a page with `css` (YouTube's stylesheet) in <head>. */
function boot(css, opts = {}) {
  const infos = [];
  const { win, doc, errors } = bootPage({
    code,
    head: css ? `<style id="yt-css">${css}</style>` : '',
    bodyClass: 'WEB_PAGE_TYPE_WATCH',
    inner: PANEL,
    url: 'https://www.youtube.com/tv#/watch?v=abcdefghijk',
    console: { info: (...a) => { const s = a.join(' '); if (s.indexOf('[CommentsFix]') !== -1) infos.push(s); } },
    config: {
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, thumbnailQuality: 'off', enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false, enableLegacyEmojiFix: false
    },
    fetch: 'pending',
    beforeEval: opts.before
  });
  const fix = () => doc.getElementById('ytaf-comments-close-fix');
  const fixText = () => (fix() || {}).textContent || '';
  // Focus landing on `el`, as the remote moves it there.
  const focus = (el) => el.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
  const addSheet = (text) => {
    const s = doc.createElement('style');
    s.textContent = text;
    doc.head.appendChild(s);
  };
  const box = () => win.getComputedStyle(doc.querySelector('.AmQJbe'));
  return { win, doc, errors, infos, fix, fixText, focus, addSheet, box };
}

const until = async (check, ms) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await wait(20);
  }
  return true;
};

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- YouTube's collapsing rule already on the page ----
  {
    const h = boot(`${OVERLAY_SEL} { height: 0px; }
      ytlr-animated-overlay.frHKed .fade { opacity: 0; }
      .AmQJbe.other { display: none; }`);
    t(n('the override is in <head> at start'), !!h.fix() && h.fix().parentNode === h.doc.head);
    t(n('...for the rule that zero-sizes the panel under the closing class'),
      h.fixText().indexOf(OVERLAY_SEL + ' {') === 0, h.fixText());
    t(n('...not for a closing-class rule that only fades'), h.fixText().indexOf('.fade') === -1, h.fixText());
    t(n('...nor for a rule without the closing class'), h.fixText().indexOf('.other') === -1, h.fixText());
    const cs = h.box();
    t(n('the closing panel keeps its size (the list never measures 0)'),
      cs.height === 'auto' && cs.display === 'block', `height=${cs.height} display=${cs.display}`);
    t(n('...and is invisible while it closes'), cs.visibility === 'hidden', cs.visibility);
    t(n('found at start: reported once'), h.infos.length === 1 && /applied to: ytlr-animated-overlay\.frHKed \.AmQJbe$/.test(h.infos[0]),
      h.infos.join(' | '));
    h.focus(h.doc.querySelector('.row'));
    await wait(30);
    t(n('found: focus in the panel scans no more'), h.infos.length === 1, h.infos.join(' | '));
    t(n('no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }

  // ---- The other closing class, the other ways to collapse, @media ----
  {
    const h = boot(`@media (min-width: 1px) { ytlr-animated-overlay.xmQAdc .AmQJbe { display: none; } }
      @supports (display: block) { @media (min-width: 1px) { .xmQAdc .list { max-height: 0; } } }
      .frHKed .rail { width: 0rem; }
      .frHKed .grow { height: 10px; width: 1px; }`);
    const text = h.fixText();
    t(n('a display:none rule inside @media is found'), text.indexOf('ytlr-animated-overlay.xmQAdc .AmQJbe {') !== -1, text);
    t(n('a max-height: 0 rule two blocks deep is found'), text.indexOf('.xmQAdc .list {') !== -1, text);
    t(n('a width: 0rem rule is found'), text.indexOf('.frHKed .rail {') !== -1, text);
    t(n('a closing-class rule with real sizes is left alone'), text.indexOf('.grow') === -1, text);
    t(n('every override keeps the element laid out but hidden'),
      text.split('\n').length === 3 && text.split('\n').every((l) =>
        /\{ display: block !important; height: auto !important; width: auto !important; max-height: none !important; visibility: hidden !important; \}$/.test(l)),
      text);
  }

  // ---- A constructed sheet, and a cross-origin one that cannot be read ----
  {
    const h = boot('', {
      before(win) {
        // A cross-origin <link> sheet: reading its rules throws, as in Chrome.
        const real = Object.getOwnPropertyDescriptor(win.Document.prototype, 'styleSheets').get;
        const locked = { get cssRules() { throw new win.DOMException('cross-origin', 'SecurityError'); } };
        Object.defineProperty(win.document, 'styleSheets', {
          configurable: true,
          get() { const list = [locked]; const own = real.call(this); for (let i = 0; i < own.length; i++) list.push(own[i]); return list; }
        });
        // A constructed sheet (document.adoptedStyleSheets, Chrome 73+), and one
        // whose rules cannot be read.
        const sheet = new win.CSSStyleSheet();
        sheet.insertRule('ytlr-animated-overlay.frHKed .AmQJbe { height: 0px; }', 0);
        win.document.adoptedStyleSheets = [locked, sheet];
      }
    });
    t(n('a rule in an adopted sheet is found, past sheets that cannot be read'),
      h.fixText().indexOf(OVERLAY_SEL + ' {') === 0, h.fixText());
    t(n('unreadable sheets: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }

  // ---- No rule yet: the fallback, then the scan when a panel takes focus ----
  {
    const h = boot('');
    t(n('no rule at start: the fallback override'),
      h.fixText() === 'ytlr-animated-overlay.frHKed .AmQJbe, ytlr-animated-overlay.frHKed .AmQJbe * { display: revert !important; }',
      h.fixText());
    t(n('...without a report at start'), h.infos.length === 0, h.infos.join(' | '));
    h.focus(h.doc.getElementById('elsewhere'));
    t(n('focus outside a panel scans nothing'), h.infos.length === 0, h.infos.join(' | '));
    // A focusin on the document itself (no element to look up from).
    h.doc.dispatchEvent(new h.win.FocusEvent('focusin'));
    t(n('a focusin with no element scans nothing'), h.infos.length === 0, h.infos.join(' | '));
    h.focus(h.doc.querySelector('.AmQJbe'));
    t(n('focus in the panel scans and reports the fallback'),
      h.infos.length === 1 && /No collapsing close rule found \(scan 1\/3\), using fallback/.test(h.infos[0]), h.infos.join(' | '));
    // YouTube's CSS arrives; the next panel opens before the startup retry.
    h.addSheet(`${OVERLAY_SEL} { height: 0px; }`);
    h.focus(h.doc.querySelector('ytlr-engagement-panel-section-list-renderer .row'));
    t(n('the next panel focus finds the rule at once'), h.fixText().indexOf(OVERLAY_SEL + ' {') === 0, h.fixText());
    t(n('...in the same <style>, not a second one'),
      h.doc.querySelectorAll('#ytaf-comments-close-fix').length === 1);
    t(n('...and the panel keeps its size'), h.box().height === 'auto' && h.box().visibility === 'hidden', h.box().height);
    const before = h.infos.length;
    h.focus(h.doc.querySelector('.row'));
    h.focus(h.doc.querySelector('.row'));
    t(n('found on focus: no more scans'), h.infos.length === before && before === 2, h.infos.join(' | '));
  }

  // ---- At most three focus scans; the startup retry carries on ----
  {
    const h = boot('');
    const row = h.doc.querySelector('.row');
    for (let i = 0; i < 5; i++) h.focus(row);
    const misses = h.infos.filter((s) => /No collapsing close rule found/.test(s));
    t(n('five panel focuses, three scans'), misses.length === 3 && /scan 3\/3/.test(misses[2]), misses.join(' | '));
    // YouTube's CSS shows up late: the focus scan is spent, the startup retry
    // (once a second) picks it up.
    h.addSheet(`${OVERLAY_SEL} { height: 0px; }`);
    h.focus(row);
    t(n('...the fourth focus does not scan'), h.fixText().indexOf('display: revert') !== -1, h.fixText());
    const found = await until(() => h.fixText().indexOf(OVERLAY_SEL + ' {') === 0, 5000);
    t(n('the startup retry finds CSS that loads late'), found, h.fixText());
    t(n('...and reports it'), /applied to/.test(h.infos[h.infos.length - 1]), h.infos.join(' | '));
    t(n('scans: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }
});
