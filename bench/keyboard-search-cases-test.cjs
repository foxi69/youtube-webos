/**
 * Type in Search with a Keyboard (src/keyboard-search.js), case by case in the
 * bundle: the first character probes whether YouTube types by itself; if not,
 * each way of pressing an on-screen key (click, pointer events, the key's own
 * onSelect) is tried until one changes the query, and the rest is typed with
 * it. Then Space, Backspace, Enter and digits, the keys that must stay the
 * remote's, a TV on which nothing works, and a visit that starts over.
 * keyboard-search-test covers a query box that goes away during the probe.
 *
 *   node bench/keyboard-search-cases-test.cjs <bundle> [legacy|modern]
 *
 * The page is a stand-in for YouTube's search page: a query box and an
 * on-screen keyboard whose keys type into it only when pressed the way the
 * case says. Key presses are dispatched as trusted, as the remote's are.
 */
const { createReporter, flavorFromArgs, readBundle, bootPage, dispatchTrusted, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const code = readBundle();
// Each decision takes 400 ms or more of the page's timers; poll for its
// outcome rather than count on exact timing.
const until = async (fn, max = 4000) => {
  for (const end = Date.now() + max; !fn() && Date.now() < end;) await wait(20);
};

const { t, run } = createReporter();

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789,'.split('');

/**
 * The bundle on the search page. `yt.press` is how an on-screen key reacts:
 * 'click', 'pointer' (mousedown only), 'instance' (the key's __instance.
 * onSelect), or 'none'. `yt.native`: YouTube types a keyboard's keys itself.
 * `yt.classKeys`: keys are plain divs named by class, the query an <input>.
 */
// Every boot's errors, checked once at the end.
const allErrors = [];

async function boot(yt = {}, cfg = {}) {
  const { win, doc, errors, evaluate } = bootPage({
    code,
    bodyClass: yt.page || 'WEB_PAGE_TYPE_SEARCH',
    url: 'https://www.youtube.com/tv#/search',
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false, enableDeArrow: false,
      thumbnailQuality: 'off', enableAutoLogin: false, checkForUpdates: false, showWhatsNew: false
    }, cfg),
    fetch: 'pending',
    evaluate: false
  });
  allErrors.push(errors);
  // Everything is on screen at 40x40, except what the test hides.
  win.Element.prototype.getBoundingClientRect = function () {
    const s = this.hasAttribute('data-hidden') ? 0 : 40;
    return { top: 0, left: 0, right: s, bottom: s, width: s, height: s, x: 0, y: 0 };
  };
  let skew = 0;
  const realNow = win.Date.now;
  win.Date.now = () => realNow.call(win.Date) + skew;

  const app = doc.querySelector('ytlr-app');
  let box = null;
  const state = { submitted: [], presses: [], works: yt.press || 'click', ytSaw: [], ytSawUp: [] };
  const queryEl = () => (yt.classKeys ? box && box.querySelector('input') : box && box.querySelector('span'));
  const getQuery = () => { const q = queryEl(); return q ? (yt.classKeys ? q.value : q.textContent) : null; };
  const setQuery = (v) => { const q = queryEl(); if (yt.classKeys) q.value = v; else q.textContent = v; };
  const addBox = () => {
    box = doc.createElement(yt.classKeys ? 'ytlr-search-bar' : 'ytlr-search-text-box');
    box.appendChild(doc.createElement(yt.classKeys ? 'input' : 'span'));
    app.insertBefore(box, app.firstChild);
  };
  const removeBox = () => { box.parentNode.removeChild(box); box = null; };
  if (!yt.noBox) addBox();

  // What a key does once pressed.
  const act = (job) => {
    const q = getQuery();
    if (q === null) return;
    if (job === 'space') setQuery(q + ' ');
    else if (job === 'backspace') setQuery(q.slice(0, -1));
    else if (job === 'search') state.submitted.push(q);
    else setQuery(q + job);
  };
  const wire = (el, job) => {
    const hit = (how) => { state.presses.push(job + ':' + how); if (state.works === how) act(job); };
    el.addEventListener('click', () => hit('click'));
    el.addEventListener('mousedown', (e) => { state.lastPointer = e; hit('pointer'); });
    el.__instance = { onSelect: () => hit('instance') };
    return el;
  };
  const kbd = doc.createElement('div');
  if (yt.classKeys) {
    const key = (label, job, icon) => {
      const k = doc.createElement('div');
      k.className = 'ytLrKeyboardKeyHost';
      const inner = doc.createElement('span');
      inner.className = icon || 'ytLrKeyboardKeyLabel';
      if (label) inner.textContent = label;
      k.appendChild(inner);
      kbd.appendChild(wire(k, job));
      return k;
    };
    // An 'a' key that is not on screen comes first: it must be passed over.
    const hidden = key('a', 'A!');
    hidden.setAttribute('data-hidden', '');
    for (const ch of LETTERS) key(ch, ch);
    key('', 'space', 'ytLrIcon ytLrSpaceBarIcon');
    key('', 'backspace', 'ytLrIcon ytLrBackspaceIcon');
    key('', 'search', 'ytLrIcon ytLrSearchIcon');
  } else {
    const key = (label, job, html) => {
      const k = doc.createElement('ytlr-keyboard-key');
      if (label) k.setAttribute('aria-label', label);
      if (html) k.innerHTML = html; else k.textContent = label;
      kbd.appendChild(wire(k, job));
    };
    for (const ch of LETTERS) key(ch, ch);
    key('Space', 'space');
    key(null, 'backspace', '<yt-icon class="ytLrIconBackspace"></yt-icon>');
    key('Search', 'search');
  }
  app.appendChild(kbd);

  // YouTube's own key handling, after the module's window capture listener.
  doc.addEventListener('keydown', (e) => {
    state.ytSaw.push(e.key || String(e.keyCode));
    if (!yt.native) return;
    const q = getQuery();
    if (q === null) return;
    if (e.key === 'Backspace') setQuery(q.slice(0, -1));
    else if (e.key && e.key.length === 1) setQuery(q + e.key);
  });
  doc.addEventListener('keyup', (e) => state.ytSawUp.push(e.key || String(e.keyCode)));

  evaluate();
  await wait(300);

  // A key press from a keyboard: keydown, then keyup. Returns false when the
  // keydown was taken (default prevented).
  const press = (k, o = {}) => {
    const name = o.noKey ? '' : k;
    const kc = o.keyCode !== undefined ? o.keyCode
      : k === 'Enter' ? 13 : k === 'Backspace' ? 8 : k === ' ' ? 32 : k === 'ArrowLeft' ? 37
        : k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
    const mk = (type) => {
      const e = new win.KeyboardEvent(type, { key: name, bubbles: true, cancelable: true,
        ctrlKey: !!o.ctrl, shiftKey: !!o.shift });
      Object.defineProperty(e, 'keyCode', { get: () => kc, configurable: true });
      if (o.synthetic) e.__ytafSynthetic = true;
      return e;
    };
    const target = o.target || doc.activeElement || doc.body;
    const fire = o.untrusted ? (el, e) => el.dispatchEvent(e) : dispatchTrusted;
    const taken = !fire(target, mk('keydown'));
    fire(target, mk('keyup'));
    return !taken;
  };
  const typeAll = (s) => { for (const ch of s) press(ch); };
  const setPage = async (cls) => { doc.body.className = cls; await wait(20); };
  return { win, doc, errors, state, press, typeAll, query: getQuery, addBox, removeBox, setPage,
    setSkew: (ms) => { skew = ms; } };
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  // ---- On-screen keys that work with click() ----
  {
    const b = await boot({ press: 'click' });
    const { state } = b;
    const first = b.press('h');
    b.press('i');
    t(n('the first characters go to YouTube while it is probed'), first === true && state.ytSaw.join() === 'h,i',
      state.ytSaw.join());
    // 400 ms to see YouTube did nothing, then 400 ms to see click() work;
    // only then is the queued 'i' typed.
    await until(() => state.presses.length >= 2);
    t(n('YouTube did not type them: they are typed on the on-screen keys'), b.query() === 'hi', JSON.stringify(b.query()));
    t(n('with click(), the first way tried'), state.presses.join() === 'h:click,i:click', state.presses.join());

    state.ytSaw.length = 0; state.ytSawUp.length = 0;
    const x = b.press('x');
    t(n('the next letter is taken and typed at once'), x === false && b.query() === 'hix' && !state.ytSaw.length,
      JSON.stringify(b.query()) + ' saw ' + state.ytSaw.join());
    t(n('its keyup is taken too'), !state.ytSawUp.length, state.ytSawUp.join());
    b.press(' ');
    t(n('Space presses the Space key'), b.query() === 'hix ', JSON.stringify(b.query()));
    t(n('a digit right after typing is typed'), b.press('5') === false && b.query() === 'hix 5', JSON.stringify(b.query()));
    t(n('Backspace presses the backspace key'), b.press('Backspace') === false && b.query() === 'hix ',
      JSON.stringify(b.query()));

    // Keys a keyboard without KeyboardEvent.key (Chrome 38) sends.
    b.press('', { noKey: true, keyCode: 65 });
    b.press('', { noKey: true, keyCode: 188 });
    b.press('', { noKey: true, keyCode: 50 });
    b.press('', { noKey: true, keyCode: 32 });
    const shifted = b.press('', { noKey: true, keyCode: 49, shift: true });
    t(n('key codes alone: A, comma, 2 and Space are typed, Shift+1 is not'),
      b.query() === 'hix a,2 ' && shifted === true, JSON.stringify(b.query()));

    t(n('Enter right after typing presses the search key'),
      b.press('Enter') === false && state.submitted.join() === 'hix a,2 ', state.submitted.join());
    t(n('after the search, Backspace is the remote\'s again'),
      b.press('Backspace') === true && b.query() === 'hix a,2 ');
    t(n('after the search, Enter is OK again'), b.press('Enter') === true && state.submitted.length === 1);

    // Keys that stay the remote's.
    state.ytSaw.length = 0;
    const before = b.query();
    b.setSkew(4000);   // more than three seconds since anything was typed
    t(n('a digit on its own is a remote shortcut, not typed'), b.press('7') === true && b.query() === before);
    t(n('an arrow is left alone'), b.press('ArrowLeft') === true);
    t(n('Ctrl+a is left alone'), b.press('a', { ctrl: true }) === true && b.query() === before);
    const input = b.doc.createElement('input');
    b.doc.body.appendChild(input);
    t(n('a key aimed at a text field is left alone'), b.press('a', { target: input }) === true && b.query() === before);
    const panel = b.doc.createElement('div');
    panel.className = 'ytaf-ui-container';
    const btn = b.doc.createElement('button');
    panel.appendChild(btn);
    b.doc.body.appendChild(panel);
    btn.focus();
    t(n('a key while the settings panel has the focus is left alone'), b.press('a') === true && b.query() === before);
    btn.blur();
    t(n('a key the page made up (untrusted) is left alone'), b.press('a', { untrusted: true }) === true);
    t(n('a key the mod sent itself is left alone'), b.press('a', { synthetic: true }) === true);
    t(n('...and none of those typed anything'), b.query() === before && state.ytSaw.length === 7, state.ytSaw.join());
    t(n('a letter after a pause is typed straight away'), b.press('z') === false && b.query() === before + 'z');
    t(n('no console errors'), !b.errors.length, b.errors[0]);
  }

  // ---- Keys that only react to pointer events ----
  {
    const b = await boot({ press: 'pointer' });
    b.typeAll('ab');
    await until(() => b.query() === 'ab');   // click() tried for 400 ms, then pointer events
    // A pointer press ends in a click event as well.
    t(n('pointer-only keys: found after click() fails, both letters typed'),
      b.query() === 'ab' && b.state.presses.join() === 'a:click,a:pointer,a:click,b:pointer,b:click', b.state.presses.join());
    const e = b.state.lastPointer;
    t(n('the pointer press lands on the key\'s centre'), e && e.clientX === 20 && e.clientY === 20 && e.button === 0,
      e && e.clientX + ',' + e.clientY);
    b.press('c');
    t(n('pointer-only keys: later letters typed the same way'), b.query() === 'abc', JSON.stringify(b.query()));
  }

  // ---- Keys that only react through their own onSelect ----
  {
    const b = await boot({ press: 'instance' });
    b.typeAll('ok');
    await until(() => b.query() === 'ok');
    t(n('instance-only keys: the third way works, both letters typed'),
      b.query() === 'ok' && b.state.presses.join() === 'o:click,o:pointer,o:click,o:instance,k:instance', b.state.presses.join());
    b.state.ytSaw.length = 0;
    const through = b.press('!');   // no such key on this keyboard
    t(n('a character with no on-screen key is let through to YouTube'),
      through === true && b.state.ytSaw.join() === '!' && b.query() === 'ok', `${through} ${b.state.ytSaw.join()} ${b.query()}`);
  }

  // ---- YouTube types by itself ----
  {
    const b = await boot({ native: true });
    b.press('h');
    await wait(450);
    const p = b.state.presses.length;
    const e = b.press('e');
    t(n('YouTube types by itself: keys go to it, nothing pressed for it'),
      e === true && b.query() === 'he' && p === 0 && b.state.presses.length === 0,
      JSON.stringify(b.query()) + ' ' + b.state.presses.join());
    t(n('YouTube types by itself: Backspace is YouTube\'s'), b.press('Backspace') === true && b.query() === 'h');
    // webOS 25 types by itself but takes Enter as OK on the focused key.
    t(n('YouTube types by itself: Enter still presses search, with pointer events'),
      b.press('Enter') === false && b.state.submitted.join() === 'h' && b.state.presses.join() === 'search:pointer,search:click',
      b.state.presses.join());
  }

  // ---- Nothing works, then a new visit ----
  {
    const b = await boot({ press: 'none' });
    b.press('q');
    // The probe, then three ways, 400 ms each.
    await until(() => b.state.presses.length >= 4);
    await wait(500);
    const tried = b.state.presses.join();
    t(n('no way of pressing works: all three are tried'), tried === 'q:click,q:pointer,q:click,q:instance', tried);
    t(n('then keys are left alone'), b.press('w') === true && b.state.presses.join() === tried);
    await b.setPage('WEB_PAGE_TYPE_BROWSE');
    t(n('off the search page, keys are left alone'), b.press('w') === true && b.state.presses.join() === tried);
    b.state.works = 'click';   // the keyboard is up this time
    await b.setPage('WEB_PAGE_TYPE_SEARCH');
    b.press('w');
    await until(() => b.query() === 'w');
    t(n('back on the search page, it tries again and types'), b.query() === 'w', JSON.stringify(b.query()));
  }

  // ---- A character with no key, during the probe ----
  {
    const b = await boot({ press: 'click' });
    b.press('é');   // no such key on this keyboard
    b.press('a');
    await until(() => b.query() === 'a');
    t(n('a probed character with no key is dropped, the next one decides'), b.query() === 'a', JSON.stringify(b.query()));
  }

  // ---- Keys named by class, the query in an <input> ----
  {
    const b = await boot({ press: 'click', classKeys: true });
    b.typeAll('ab');
    await until(() => b.query() === 'ab');
    b.press(' ');
    b.press('c');
    t(n('class-named keys: the visible key is pressed, icon-only Space found'),
      b.query() === 'ab c' && b.state.presses.indexOf('A!:click') === -1, JSON.stringify(b.query()) + ' ' + b.state.presses.join());
    b.press('Backspace');
    b.press('Enter');
    t(n('class-named keys: icon-only backspace and search found'),
      b.query() === 'ab ' && b.state.submitted.join() === 'ab ', JSON.stringify(b.query()));
  }

  // ---- The query box goes while a press is being tried ----
  {
    const b = await boot({ press: 'pointer' });
    b.press('a');
    // click() is pressed once YouTube did nothing; its result is due 400 ms later.
    await until(() => b.state.presses.length === 1);
    b.removeBox();
    await wait(600);
    b.addBox();
    t(n('a query box gone while a press is tried decides nothing'), b.query() === '' && b.state.presses.join() === 'a:click',
      b.state.presses.join());
    b.press('c');
    await until(() => b.query() === 'c');
    t(n('...the next character probes again and is typed'), b.query() === 'c', JSON.stringify(b.query()));
  }

  // ---- When the module stays out ----
  {
    const b = await boot({ press: 'click' }, { keyboardSearch: false });
    const through = b.press('a');
    await wait(450);
    t(n('setting off: nothing typed, the key is YouTube\'s'), through === true && b.state.ytSaw.join() === 'a' &&
      b.query() === '' && !b.state.presses.length, `${through} ${b.state.ytSaw.join()}`);
  }
  {
    const b = await boot({ press: 'click', page: 'WEB_PAGE_TYPE_BROWSE' });
    const through = b.press('a');
    await wait(450);
    t(n('not the search page: nothing typed, the key is YouTube\'s'), through === true && b.state.ytSaw.join() === 'a' &&
      b.query() === '' && !b.state.presses.length, `${through} ${b.state.ytSaw.join()}`);
  }
  {
    const b = await boot({ press: 'click', noBox: true });
    const through = b.press('a');
    await wait(450);
    t(n('no query box to watch: nothing pressed, the key is YouTube\'s'), through === true && b.state.ytSaw.join() === 'a' &&
      !b.state.presses.length, `${through} ${b.state.ytSaw.join()} ${b.state.presses.join()}`);
    // Every case's boot, not only this one's.
    const every = [].concat(...allErrors);
    t(n('no console errors in any case'), !every.length, every[0]);
  }
});
