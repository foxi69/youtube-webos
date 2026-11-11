// Loaded with --require by bench/ci.sh --late: every test then sees the page
// as the TV has it when the userScript runs, seconds after the page started,
// with document.readyState 'complete' already. jsdom reports 'loading' at that
// point, so code that only runs once the page has loaded (or waits for an
// event that has already fired on a TV) was not tested as it runs there.
const jsdom = require('jsdom');

const Base = jsdom.JSDOM;
class LateJSDOM extends Base {
  constructor(...args) {
    super(...args);
    const doc = this.window.document;
    Object.defineProperty(doc, 'readyState', { get: () => 'complete', configurable: true });
  }
}
// The static helpers (fromURL, fromFile, fragment) stay as they are.
Object.getOwnPropertyNames(Base).forEach((name) => {
  if (!(name in LateJSDOM)) LateJSDOM[name] = Base[name];
});
jsdom.JSDOM = LateJSDOM;
