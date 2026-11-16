/**
 * Behaviour test for src/math-letters.js: "fancy font" titles and channel
 * names written in Mathematical Alphanumeric Symbols (U+1D400-1D7FF: 𝐁𝐨𝐥𝐝,
 * 𝓢𝓬𝓻𝓲𝓹𝓽, 𝕯𝖔𝖚𝖇𝖑𝖊, 𝟏𝟐𝟑) have no glyphs in any webOS font and show as boxes,
 * so each one becomes its plain letter or digit. Only that block: other
 * compatibility characters (ligatures, full-width letters, superscripts) and
 * other surrogate pairs (emoji) render, and must stay as they are. Also: text
 * added or changed later, the legacy emoji fix's math font turning the
 * rewrite off, and engines without String#normalize or MutationObserver.
 *
 * A unit test: the module is imported straight from src/ into a jsdom page,
 * fresh for each case (it keeps state from load time).
 *
 * Usage: node bench/math-letters-test.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');
const { createReporter } = require('./harness.cjs');

const MODULE = pathToFileURL(path.resolve(__dirname, '..', 'src/math-letters.js')).href;
const tick = () => new Promise((r) => setTimeout(r, 0));

const { t, run } = createReporter();

let fresh = 0;
/** A jsdom page as the globals the module sees, and the module loaded anew. */
async function load(html, opts = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head>' + (html === null ? '' : '<body>' + html + '</body>') + '</html>');
  const win = dom.window;
  if (html === null) win.document.documentElement.removeChild(win.document.body);
  globalThis.document = win.document;
  globalThis.NodeFilter = win.NodeFilter;
  globalThis.MutationObserver = opts.noMutationObserver ? undefined : win.MutationObserver;
  const normalize = String.prototype.normalize;
  if (opts.noNormalize) delete String.prototype.normalize;
  let mod;
  try {
    mod = await import(MODULE + '?case=' + (++fresh));
  } finally {
    if (opts.noNormalize) String.prototype.normalize = normalize;
  }
  return { win, doc: win.document, init: mod.initMathLetters };
}

// Records the text changes on the page: the text each one replaced.
function watchWrites(win) {
  const recs = [];
  new win.MutationObserver((r) => { for (const x of r) if (x.type === 'characterData') recs.push(x.oldValue); })
    .observe(win.document.body, { subtree: true, characterData: true, characterDataOldValue: true });
  return recs;
}
const hasMath = (s) => s.indexOf('\uD835') !== -1;

run(async () => {
  // ---- What is replaced, what is not ----
  {
    const { doc, init } = await load(
      '<p id="bold">\u{1D401}\u{1D428}\u{1D425}\u{1D41D} title</p>' +
      '<p id="script">\u{1D4E2}\u{1D4EC}\u{1D4FB}\u{1D4F2}\u{1D4F9}\u{1D4FD}</p>' +
      '<p id="fraktur"><b>\u{1D56F}\u{1D594}\u{1D59A}</b><i>\u{1D587}\u{1D591}\u{1D58A}</i></p>' +
      '<p id="digits">\u{1D7CF}\u{1D7D0}\u{1D7D1} / \u{1D7F6}\u{1D7FF}</p>' +
      '<p id="greek">\u{1D6C2}\u{1D6C3} \u{1D6A4}</p>' +
      '<p id="others">ﬁ ＡＢ x² ℌ \u{1F600} café</p>' +
      '<p id="hole">a\u{1D455}b \u{1D7CC}</p>' +
      '<p id="mixed">\u{1F525} \u{1D405}\u{1D422}\u{1D42B}\u{1D41E} \u{1F525}</p>' +
      '<p id="beside">\u{1D400} \uFB01 \uFF21 x\u00B2</p>');
    init();
    const txt = (id) => doc.getElementById(id).textContent;
    t('bold letters become plain, plain text stays', txt('bold') === 'Bold title', txt('bold'));
    t('script letters become plain', txt('script') === 'Script', txt('script'));
    t('bold fraktur across elements becomes plain', txt('fraktur') === 'Double', txt('fraktur'));
    t('math digits become plain digits', txt('digits') === '123 / 09', txt('digits'));
    t('math Greek becomes plain Greek, dotless i stays dotless', txt('greek') === 'αβ ı', txt('greek'));
    t('ligature, full-width, superscript, emoji and accents are left alone',
      txt('others') === 'ﬁ ＡＢ x² ℌ \u{1F600} café', JSON.stringify(txt('others')));
    t('reserved code points in the block (no plain form) are left as they are',
      txt('hole') === 'a\u{1D455}b \u{1D7CC}', JSON.stringify(txt('hole')));
    t('emoji around math letters stay', txt('mixed') === '\u{1F525} Fire \u{1F525}', txt('mixed'));
    t('in the same text, only the math letter changes',
      txt('beside') === 'A \uFB01 \uFF21 x\u00B2', JSON.stringify(txt('beside')));
    t('the bold paragraph keeps its one text node', doc.getElementById('bold').childNodes.length === 1);
  }

  // ---- Text that arrives later ----
  {
    const { win, doc, init } = await load('<div id="app"></div>');
    init();
    const writes = watchWrites(win);
    const app = doc.getElementById('app');

    const tile = doc.createElement('div');
    tile.innerHTML = '<span>\u{1D413}\u{1D422}\u{1D42D}\u{1D425}\u{1D41E}</span><span>by \u{1D402}\u{1D421}</span>';
    app.appendChild(tile);
    await tick();
    t('an added element: its text is fixed', tile.textContent === 'Titleby Ch', tile.textContent);

    const node = doc.createTextNode('\u{1D7D7}\u{1D7D6} views');
    app.appendChild(node);
    await tick();
    t('an added text node is fixed', node.data === '98 views', node.data);

    node.data = 'now \u{1D41A}\u{1D41B}';
    await tick();
    t('changed text is fixed', node.data === 'now ab', node.data);

    const plain = doc.createElement('p');
    plain.textContent = 'plain words';
    app.appendChild(plain);
    plain.firstChild.data = 'other plain words';
    await tick();
    // Our own write of a fix comes back as a mutation: it must not loop, and
    // text with nothing to fix is never written.
    // Six changes: the module's four fixes and the test's own two writes.
    t('each fix is written once, plain text never', writes.length === 6
      && writes.filter(hasMath).length === 4, JSON.stringify(writes));

    const hole = doc.createTextNode('');
    app.appendChild(hole);
    await tick();
    writes.length = 0;
    hole.data = 'x\u{1D455}';
    await tick();
    t('text with only a reserved code point is not rewritten', writes.length === 1 && hole.data === 'x\u{1D455}',
      JSON.stringify(writes));

    const note = doc.createComment('\u{1D400}');
    app.appendChild(note);
    await tick();
    t('a comment is left alone', note.data === '\u{1D400}');
  }

  // ---- The legacy emoji fix's math font draws them: hands off ----
  {
    const { doc, init } = await load('<p id="p">\u{1D401}</p>');
    doc.documentElement.classList.add('ytaf-legacy-emoji');
    init();
    const p = doc.getElementById('p');
    t('math font on: the page is not rewritten', p.textContent === '\u{1D401}');
    const q = doc.createElement('p');
    q.textContent = '\u{1D402}';
    doc.body.appendChild(q);
    await tick();
    t('math font on: added text is not rewritten', q.textContent === '\u{1D402}');
    doc.documentElement.classList.remove('ytaf-legacy-emoji');
    const r = doc.createElement('p');
    r.textContent = '\u{1D403}';
    doc.body.appendChild(r);
    await tick();
    t('math font off again: new text is fixed', r.textContent === 'D', r.textContent);
  }

  // ---- Before <body> exists ----
  {
    const { win, doc, init } = await load(null);
    init();
    const body = doc.createElement('body');
    body.innerHTML = '<p>\u{1D400}\u{1D401}</p>';
    doc.documentElement.appendChild(body);
    t('no body yet: nothing done before DOMContentLoaded', body.textContent === '\u{1D400}\u{1D401}');
    doc.dispatchEvent(new win.Event('DOMContentLoaded'));
    t('no body yet: fixed on DOMContentLoaded', body.textContent === 'AB', body.textContent);
    const later = doc.createElement('p');
    later.textContent = '\u{1D402}';
    body.appendChild(later);
    await tick();
    t('no body yet: watched after DOMContentLoaded', later.textContent === 'C', later.textContent);
  }

  // ---- Engines without what it needs ----
  {
    const { doc, init } = await load('<p id="p">\u{1D400}</p>', { noNormalize: true });
    let threw = null;
    try { init(); } catch (e) { threw = e; }
    t('no String#normalize: does nothing, throws nothing',
      !threw && doc.getElementById('p').textContent === '\u{1D400}', threw && threw.message);
  }
  {
    const { doc, init } = await load('<p id="p">\u{1D400}</p>', { noMutationObserver: true });
    let threw = null;
    try { init(); } catch (e) { threw = e; }
    t('no MutationObserver: does nothing, throws nothing',
      !threw && doc.getElementById('p').textContent === '\u{1D400}', threw && threw.message);
  }
});
