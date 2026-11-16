/**
 * Type in Search with a Keyboard (src/keyboard-search.js): the first character
 * is a probe of whether YouTube types by itself. A query box that went away
 * while it waited (Back pressed at once) settles nothing: the next character
 * decides, and on a TV that does not type by itself the on-screen keys are
 * still pressed. It used to read the missing box as YouTube typing natively,
 * and left the keyboard alone for the rest of the session.
 *
 * Usage: node bench/keyboard-search-test.cjs [bundle] [legacy|modern]
 */
const { bootPage, trustedKey, wait, UA } = require('./harness.cjs');

let passed = 0;
let failed = 0;
const t = (name, ok, extra) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || extra === undefined ? '' : ' -> ' + extra}`);
};

// The bundle of the command line: `modern` is the modern one (webOS 22 and
// newer) in a Chrome 87 environment, instead of the legacy one in a Chrome 38
// one. The user agent is webOS 23 on both. Only page script errors are
// collected, and the environment is left without Element#remove.
const { win, doc, errors } = bootPage({
  bodyClass: 'WEB_PAGE_TYPE_SEARCH',
  inner: '<ytlr-search-text-box><span></span></ytlr-search-text-box>' +
    '<ytlr-keyboard-key aria-label="a">a</ytlr-keyboard-key><ytlr-keyboard-key aria-label="b">b</ytlr-keyboard-key>',
  url: 'https://www.youtube.com/tv#/search',
  userAgent: UA.webos23,
  config: { enableAdBlock: false, checkForUpdates: false, showWhatsNew: false },
  // Before the environment is applied: the Chrome 38 one takes this fetch
  // away again, so only the modern build has it.
  setup(w) {
    w.fetch = () => new Promise(() => {});
    w.Element.prototype.getBoundingClientRect = function () {
      return { top: 0, left: 0, right: 40, bottom: 40, width: 40, height: 40, x: 0, y: 0 };
    };
  },
  consoleErrors: false,
  restoreRemove: false
});

const app = doc.querySelector('ytlr-app');
// An on-screen key types its label into the query; YouTube itself does
// nothing with a keyboard's keys on this TV.
for (const k of doc.querySelectorAll('ytlr-keyboard-key')) {
  k.addEventListener('click', () => {
    const box = doc.querySelector('ytlr-search-text-box span');
    if (box) box.textContent += k.getAttribute('aria-label');
  });
}
const type = (ch) => trustedKey(win, ch.toUpperCase().charCodeAt(0), doc.body, 'keydown', { key: ch });
const query = () => (doc.querySelector('ytlr-search-text-box') || {}).textContent;

(async () => {
  await wait(300);
  type('a');
  // The query box goes before the probe settles.
  const box = doc.querySelector('ytlr-search-text-box');
  box.parentNode.removeChild(box);
  await wait(600);
  // Back again, with an empty query.
  const again = doc.createElement('ytlr-search-text-box');
  again.appendChild(doc.createElement('span'));
  app.insertBefore(again, app.firstChild);
  type('b');
  await wait(1500);
  t('a query box gone during the probe settles nothing: the next character is typed on the on-screen keys',
    query() === 'b', JSON.stringify(query()));
  t('no jsdomError', errors.length === 0, errors[0]);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
