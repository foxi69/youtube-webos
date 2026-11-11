// Loaded with --require by bench/ci.sh --late: every test then sees the page
// as the TV has it when the userScript runs, seconds after the page started.
// jsdom has the page still loading when a test evaluates the bundle, so code
// that only runs once the page has loaded (or waits for an event that has
// already fired on a TV) was not tested as it runs there.
//
// Two things make it so: document.readyState reads 'complete', and a
// DOMContentLoaded or load listener the bundle adds while it is evaluated is
// never called, since on a TV those events are over by then. (jsdom still
// fires them a moment later; without the second part, code that waited for
// them would pass here and never start on a TV.)
const jsdom = require('jsdom');

const LIFECYCLE = { DOMContentLoaded: true, load: true };

function simulateLateInjection(win) {
  const doc = win.document;
  Object.defineProperty(doc, 'readyState', { get: () => 'complete', configurable: true });

  let evaluating = 0;
  const realEval = win.eval;
  win.eval = function (code) {
    evaluating++;
    try {
      return realEval.call(win, code);
    } finally {
      evaluating--;
    }
  };

  for (const target of [win, doc]) {
    const add = target.addEventListener;
    target.addEventListener = function (type, listener, options) {
      if (evaluating && LIFECYCLE[type]) return undefined;
      return add.call(this, type, listener, options);
    };
  }
}

const Base = jsdom.JSDOM;
class LateJSDOM extends Base {
  constructor(...args) {
    super(...args);
    simulateLateInjection(this.window);
  }
}
// The static helpers (fromURL, fromFile, fragment) stay as they are.
Object.getOwnPropertyNames(Base).forEach((name) => {
  if (!(name in LateJSDOM)) LateJSDOM[name] = Base[name];
});
jsdom.JSDOM = LateJSDOM;
