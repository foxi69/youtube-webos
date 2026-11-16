/**
 * The legacy emoji fix's drawing side (emoji-font.js, webOS 3 and 4): the
 * Chrome of those TVs has no colour emoji font, so adblock.js wraps each emoji
 * of a response in U+200B...U+200C and this module draws the wrapped ones as
 * twemoji images once they are on the page. dependency-test and
 * emoji-loop-test cover the wrapping and the observer settling; this test
 * checks what ends up on screen: the image and its hidden-text twin, the text
 * around them kept in order, several emoji in one title, a title that changes
 * in place, a sequence twemoji draws in parts, a symbol it leaves as text,
 * the elements it stays out of, a title gone before the frame, a page with
 * more emoji than the cache holds, and the fonts it adds. The module is
 * legacy-only: on the modern build, and on webOS 5 with the legacy one, it
 * must do nothing.
 *
 *   node bench/emoji-font-test.cjs <bundle> [legacy|modern]
 *
 * Frames are run by the test (requestAnimationFrame is queued), so "before
 * the frame" and "after it" are exact.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { applyChrome38Downgrade, applyChrome87Downgrade, UA, setUserAgent } = require('./chrome38-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const bundlePath = process.argv[2] || ROOT + '/dist/webOSUserScripts/userScript.js';
// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const modern = process.argv[3] === 'modern';
const code = fs.readFileSync(bundlePath, 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
// webOS 5 (2020): the legacy build, but past the TVs this fix is for.
const UA_WEBOS5 = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 WebAppManager webOS.TV-2020';

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '\n     ' + extra : '')); }
};

const W = (e) => '\u200B' + e + '\u200C';   // as adblock.js wraps an emoji
const GRIN = '\uD83D\uDE00';
const FIRE = '\uD83D\uDD25';
const HEART_ON_FIRE = '\u2764\u200D\uD83D\uDD25';   // without the U+FE0F after the heart
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/16.0.1/72x72/';

function boot(opts = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(`<!doctype html><html><head></head><body class="WEB_PAGE_TYPE_BROWSE"><ytlr-app>${opts.html || ''}</ytlr-app></body></html>`,
    { runScripts: 'outside-only', url: 'https://www.youtube.com/tv', virtualConsole: vc, pretendToBeVisual: true });
  const win = dom.window;
  setUserAgent(win, opts.ua || (modern ? UA.webos23 : UA.webos3));
  win.launchParams = '{}';
  win.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} getResponseHeader() { return null; } addEventListener() {} };
  let frames = [];
  win.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  win.cancelAnimationFrame = () => {};
  win.localStorage.setItem('ytaf-configuration', JSON.stringify(Object.assign({
    enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
    enableDeArrow: false, upgradeThumbnails: false, enableAutoLogin: false,
    checkForUpdates: false, showWhatsNew: false, enableLegacyEmojiFix: true
  }, opts.cfg)));
  if (modern) applyChrome87Downgrade(win); else applyChrome38Downgrade(win);
  win.Element.prototype.remove = function remove() { if (this.parentNode) this.parentNode.removeChild(this); };
  win.fetch = () => new Promise(() => {});
  win.eval(code);
  const doc = win.document;
  const app = doc.querySelector('ytlr-app');
  // The observers' records, then one frame.
  const frame = async () => {
    await tick();
    const q = frames; frames = [];
    for (const cb of q) cb(Date.now());
    await tick();
  };
  const pending = () => frames.length;
  // What a title shows: text as is, an image as [src name].
  const shown = (el) => {
    let out = '';
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeName === 'IMG') out += '[' + c.getAttribute('src').replace(CDN, '').replace('.png', '') + ']';
        else if (c.classList && c.classList.contains('twemoji-hidden-text')) continue;
        else walk(c);
      }
    };
    walk(el);
    return out;
  };
  const title = (text, tag = 'span') => {
    const el = doc.createElement(tag);
    el.textContent = text;
    app.appendChild(el);
    return el;
  };
  return { win, doc, app, errors, frame, pending, shown, title };
}

async function legacyCases() {
  const n = (s) => `legacy: ${s}`;

  // ---- At start ----
  {
    const h = boot({ html: `<span id="pre">Hi ${W(GRIN)} there</span>` });
    t(n('the legacy font rules are switched on (html.ytaf-legacy-emoji)'), h.doc.documentElement.classList.contains('ytaf-legacy-emoji'));
    const link = h.doc.querySelector('link[rel=stylesheet][href^="https://fonts.googleapis.com/"]');
    t(n('the Noto fonts are linked in <head>'), !!link && link.parentNode === h.doc.head &&
      /Noto\+Sans\+Arabic/.test(link.href) && /Noto\+Sans\+Math/.test(link.href), link && link.href);
    const pre = h.doc.getElementById('pre');
    await h.frame();
    t(n('a title already on the page is drawn on the first frame'), h.shown(pre) === 'Hi [1f600] there', JSON.stringify(h.shown(pre)));
    const img = pre.querySelector('emoji-render.twemoji-injected img');
    t(n('...as a twemoji image'), !!img && img.className === 'emoji' && img.getAttribute('alt') === GRIN && img.draggable === false,
      img && img.outerHTML);
    const twin = pre.querySelector('emoji-render .twemoji-hidden-text');
    t(n('...with a hidden-text twin carrying the emoji'), !!twin && twin.textContent === W(GRIN) && twin.previousSibling === img,
      twin && JSON.stringify(twin.textContent));
    t(n('...and the wrapped text itself emptied'), pre.firstChild.nodeValue === 'Hi ' && pre.childNodes[1].nodeValue === '' &&
      pre.childNodes[2].nodeName === 'EMOJI-RENDER' && pre.childNodes[3].nodeValue === ' there',
    Array.from(pre.childNodes).map((c) => c.nodeName + ':' + JSON.stringify(c.nodeValue)).join(' '));
    await h.frame();
    t(n('drawn once: nothing more to do on later frames'), pre.querySelectorAll('emoji-render').length === 1 && h.pending() === 0);
    t(n('start: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }

  // ---- Titles arriving later ----
  {
    const h = boot();
    await h.frame();
    const two = h.title(`Lofi ${W(GRIN)} beats ${W(FIRE)}!`);
    await tick();
    t(n('a new title waits for the frame'), two.querySelector('emoji-render') === null);
    await h.frame();
    t(n('two emoji in one title: both drawn, the text between kept'), h.shown(two) === 'Lofi [1f600] beats [1f525]!',
      JSON.stringify(h.shown(two)));

    // A text node added to a title that is already there.
    const holder = h.title('');
    await h.frame();
    holder.appendChild(h.doc.createTextNode(W(GRIN)));
    await h.frame();
    t(n('a text node added to a title is drawn'), h.shown(holder) === '[1f600]', JSON.stringify(h.shown(holder)));

    // YouTube reuses the title's text node for the next video.
    const textNode = holder.firstChild;
    textNode.nodeValue = W(FIRE);
    await h.frame();
    t(n('a title changed in place: its image follows'), h.shown(holder) === '[1f525]', JSON.stringify(h.shown(holder)));
    t(n('...drawn into the same element, not a second one'), holder.querySelectorAll('emoji-render').length === 1,
      holder.innerHTML);

    // Heart on fire without the presentation selector: twemoji draws it in parts.
    const heart = h.title(`I ${W(HEART_ON_FIRE)} it`);
    await h.frame();
    t(n('a sequence twemoji draws in parts: both images, the joiner kept between'),
      h.shown(heart) === 'I [2764]\u200D[1f525] it', JSON.stringify(h.shown(heart)));
    t(n('...each image with its twin'), heart.querySelectorAll('emoji-render .twemoji-hidden-text').length === 2);

    // A symbol adblock.js wraps that twemoji leaves as text (no U+FE0F).
    const copy = h.title(`Song ${W('\u00A9')} 2026`);
    await h.frame();
    t(n('a wrapped symbol twemoji has no image for stays text'),
      copy.querySelector('emoji-render') === null && copy.textContent === `Song ${W('\u00A9')} 2026`, JSON.stringify(copy.textContent));

    // Where an image cannot show: the search box.
    const box = h.doc.createElement('textarea');
    h.app.appendChild(box);
    await h.frame();
    box.appendChild(h.doc.createTextNode(W(GRIN)));
    await h.frame();
    t(n('a text box is left alone'), box.querySelector('emoji-render') === null && box.textContent === W(GRIN));
    // The same, added whole with the emoji already in it (the container scan).
    const filled = h.doc.createElement('textarea');
    filled.textContent = W(GRIN);
    h.app.appendChild(filled);
    await h.frame();
    t(n('a text box added with an emoji in it is left alone'),
      filled.querySelector('emoji-render') === null && filled.textContent === W(GRIN), JSON.stringify(filled.textContent));
    const own = h.title(W(GRIN), 'yt-icon');
    await h.frame();
    t(n('an element emoji are not drawn in is left alone'), own.querySelector('emoji-render') === null);

    // A whole tile added in one go, its title inside an element emoji are
    // not drawn in: the title is drawn all the same.
    const tile = h.doc.createElement('ytlr-tile-renderer');
    const inner = h.doc.createElement('span');
    inner.textContent = `Tile ${W(GRIN)}`;
    tile.appendChild(inner);
    h.app.appendChild(tile);
    await h.frame();
    t(n('a tile added whole: the title inside it is drawn'), h.shown(inner) === 'Tile [1f600]', JSON.stringify(h.shown(inner)));

    // Gone before the frame (a row scrolled away at once).
    const gone = h.title(`Gone ${W(GRIN)}`);
    await tick();
    gone.firstChild.remove();
    await h.frame();
    t(n('a title gone before the frame: skipped'), gone.childNodes.length === 0, gone.innerHTML);
    t(n('later titles: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }

  // ---- A whole card inserted at once ----
  {
    const h = boot();
    await h.frame();
    const card = h.doc.createElement('div');
    card.innerHTML = `<div class="title"><span>Card ${W(GRIN)}</span></div>`;
    h.app.appendChild(card);
    await h.frame();
    t(n('a card inserted whole: the title inside it is drawn'), h.shown(card) === 'Card [1f600]', JSON.stringify(h.shown(card)));
  }

  // ---- More emoji than the cache holds (500) ----
  {
    const h = boot();
    await h.frame();
    const list = h.doc.createElement('div');
    let text = '';
    const names = [];
    // 600 distinct emoji: U+1F300 on (surrogates D83C DF00 on, then D83D).
    for (let cp = 0x1F300; names.length < 600; cp++) {
      if (cp >= 0x1F3FB && cp <= 0x1F3FF) continue;   // skin tones: modifiers, not emoji
      text += W(String.fromCodePoint(cp)) + ' ';
      names.push(cp.toString(16));
    }
    list.appendChild(h.doc.createElement('span')).textContent = text;
    h.app.appendChild(list);
    await h.frame();
    const srcs = Array.from(list.querySelectorAll('img')).map((i) => i.getAttribute('src').replace(CDN, '').replace('.png', ''));
    // A few code points in the range are no emoji twemoji has: those stay text.
    const leftAsText = (h.shown(list).match(/\u200B/g) || []).length;
    const inOrder = srcs.every((s, i) => i === 0 || parseInt(s, 16) > parseInt(srcs[i - 1], 16));
    t(n('600 different emoji on one page: each drawn once, in order'),
      srcs.length > 550 && srcs.length + leftAsText === 600 && inOrder && srcs.every((s) => names.indexOf(s) !== -1),
      srcs.length + ' drawn, ' + leftAsText + ' left as text');
    // The first ones have left the cache: drawn again from scratch, and right.
    const again = h.title(W(String.fromCodePoint(0x1F300)) + W(String.fromCodePoint(0x1F4FF)));
    await h.frame();
    t(n('...and one dropped from the cache is drawn right again, beside one still in it'),
      h.shown(again) === '[1f300][1f4ff]', JSON.stringify(h.shown(again)));
    t(n('cache: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }

  // ---- Off ----
  {
    const h = boot({ cfg: { enableLegacyEmojiFix: false }, html: `<span id="pre">${W(GRIN)}</span>` });
    await h.frame();
    const late = h.title(W(GRIN));
    await h.frame();
    t(n('fix off: nothing drawn'), h.doc.querySelector('emoji-render') === null && late.textContent === W(GRIN));
  }

  // ---- webOS 5 on the legacy build: not for it ----
  {
    const h = boot({ ua: UA_WEBOS5, html: `<span id="pre">${W(GRIN)}</span>` });
    await h.frame();
    const late = h.title(W(GRIN));
    await h.frame();
    t(n('webOS 5: no legacy font rules, no font link'), !h.doc.documentElement.classList.contains('ytaf-legacy-emoji') &&
      !h.doc.querySelector('link[href^="https://fonts.googleapis.com/"]'));
    t(n('webOS 5: nothing drawn'), h.doc.querySelector('emoji-render') === null && late.textContent === W(GRIN));
    t(n('webOS 5: no page errors'), h.errors.length === 0, h.errors.join(' | '));
  }
}

async function modernCases() {
  const n = (s) => `modern: ${s}`;
  const h = boot({ html: `<span id="pre">${W(GRIN)}</span>` });
  await h.frame();
  const late = h.title(W(GRIN));
  await h.frame();
  // Its marks: the twemoji image address and the element it draws into.
  t(n('the module is not in the build'), code.indexOf('ajax/libs/twemoji') === -1 && code.indexOf('emoji-render') === -1);
  t(n('no legacy font rules, no font link'), !h.doc.documentElement.classList.contains('ytaf-legacy-emoji') &&
    !h.doc.querySelector('link[href^="https://fonts.googleapis.com/"]'));
  t(n('wrapped emoji are left as text'), h.doc.querySelector('emoji-render') === null && late.textContent === W(GRIN));
  t(n('no page errors'), h.errors.length === 0, h.errors.join(' | '));
}

(async () => {
  if (modern) await modernCases(); else await legacyCases();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
