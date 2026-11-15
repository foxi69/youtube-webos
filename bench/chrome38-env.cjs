/**
 * Chrome 38 / webOS 3 environment simulator.
 * Removes every JS built-in and DOM API that Chromium 38 does NOT ship,
 * so a bundle that relies on an unpolyfilled feature throws instead of
 * silently passing on Node 22.
 *
 * Source for the removal list: caniuse / MDN browser-compat-data,
 * "first Chrome version" > 38.
 */
function applyChrome38Downgrade(win) {
  const del = [];
  const rm = (obj, prop, label) => {
    if (obj && prop in obj) {
      try { delete obj[prop]; del.push(label); } catch { /* non-configurable */ }
    }
  };

  // --- Statics added after Chrome 38 ---
  rm(win.Object, 'assign', 'Object.assign');              // Chrome 45
  rm(win.Object, 'entries', 'Object.entries');            // Chrome 54
  rm(win.Object, 'values', 'Object.values');              // Chrome 54
  rm(win.Object, 'fromEntries', 'Object.fromEntries');    // Chrome 73
  rm(win.Object, 'getOwnPropertyDescriptors', 'Object.getOwnPropertyDescriptors'); // 54
  rm(win.Object, 'hasOwn', 'Object.hasOwn');              // Chrome 93
  rm(win.Array, 'from', 'Array.from');                    // Chrome 45
  rm(win.Array, 'of', 'Array.of');                        // Chrome 45
  rm(win.String, 'raw', 'String.raw');                    // Chrome 41

  // --- Array.prototype ---
  rm(win.Array.prototype, 'find', 'Array#find');          // Chrome 45
  rm(win.Array.prototype, 'findIndex', 'Array#findIndex');// Chrome 45
  rm(win.Array.prototype, 'includes', 'Array#includes');  // Chrome 47
  rm(win.Array.prototype, 'flat', 'Array#flat');          // Chrome 69
  rm(win.Array.prototype, 'flatMap', 'Array#flatMap');    // Chrome 69
  rm(win.Array.prototype, 'at', 'Array#at');              // Chrome 92

  // --- String.prototype ---
  rm(win.String.prototype, 'startsWith', 'String#startsWith'); // Chrome 41
  rm(win.String.prototype, 'endsWith', 'String#endsWith');     // Chrome 41
  rm(win.String.prototype, 'includes', 'String#includes');     // Chrome 41
  rm(win.String.prototype, 'repeat', 'String#repeat');         // Chrome 41
  rm(win.String.prototype, 'padStart', 'String#padStart');     // Chrome 57
  rm(win.String.prototype, 'padEnd', 'String#padEnd');         // Chrome 57
  rm(win.String.prototype, 'trimStart', 'String#trimStart');   // Chrome 66
  rm(win.String.prototype, 'trimEnd', 'String#trimEnd');       // Chrome 66
  rm(win.String.prototype, 'matchAll', 'String#matchAll');     // Chrome 73
  rm(win.String.prototype, 'replaceAll', 'String#replaceAll'); // Chrome 85
  rm(win.String.prototype, 'at', 'String#at');                 // Chrome 92

  // --- Promise combinators after 38 (base Promise exists in Chrome 32) ---
  rm(win.Promise, 'allSettled', 'Promise.allSettled');    // Chrome 76
  rm(win.Promise, 'any', 'Promise.any');                  // Chrome 85
  rm(win.Promise.prototype, 'finally', 'Promise#finally');// Chrome 63

  // --- Object/other ---
  rm(win, 'globalThis', 'globalThis');                    // Chrome 71
  rm(win, 'queueMicrotask', 'queueMicrotask');            // Chrome 71
  rm(win, 'BigInt', 'BigInt');                            // Chrome 67
  rm(win, 'Proxy', 'Proxy');                              // Chrome 49
  rm(win, 'Reflect', 'Reflect');                          // Chrome 49
  rm(win, 'AbortController', 'AbortController');          // Chrome 66
  rm(win, 'AbortSignal', 'AbortSignal');                  // Chrome 66
  rm(win, 'IntersectionObserver', 'IntersectionObserver');// Chrome 51
  rm(win, 'ResizeObserver', 'ResizeObserver');            // Chrome 64
  rm(win, 'URLSearchParams', 'URLSearchParams');          // Chrome 49
  rm(win, 'fetch', 'fetch');                              // Chrome 42
  rm(win, 'Headers', 'Headers'); rm(win, 'Request', 'Request'); rm(win, 'Response', 'Response');
  rm(win, 'CustomElementRegistry', 'CustomElementRegistry');
  rm(win, 'customElements', 'customElements');            // Chrome 54
  rm(win.Element.prototype, 'closest', 'Element#closest');// Chrome 41
  rm(win.Element.prototype, 'matches', 'Element#matches');// Chrome 34 (prefixed <34)
  rm(win.Element.prototype, 'append', 'Element#append');  // Chrome 54
  rm(win.Element.prototype, 'remove', 'Element#remove');
  rm(win.Element.prototype, 'toggleAttribute', 'Element#toggleAttribute');
  rm(win.Node.prototype, 'isConnected', 'Node#isConnected'); // Chrome 51
  rm(win.DOMTokenList && win.DOMTokenList.prototype, 'replace', 'DOMTokenList#replace');
  if (win.Symbol) { rm(win.Symbol, 'asyncIterator', 'Symbol.asyncIterator'); rm(win.Symbol, 'dispose', 'Symbol.dispose'); }

  // --- DOM collections are NOT iterable on Chromium 38 ---
  // NodeList, HTMLCollection and DOMTokenList only gained Symbol.iterator in
  // Chrome 51. jsdom makes all three iterable, so `for (const el of
  // container.children)` passed every test here while throwing
  // "Invalid attempt to iterate non-iterable instance" on a real webOS 3 TV.
  // core-js's web.dom-collections.iterator used to paper over this.
  if (win.Symbol && win.Symbol.iterator) {
    for (const ctor of ['NodeList', 'HTMLCollection', 'DOMTokenList', 'DOMStringList',
                        'FileList', 'NamedNodeMap', 'CSSRuleList', 'StyleSheetList']) {
      const C = win[ctor];
      if (C && C.prototype && C.prototype[win.Symbol.iterator]) {
        try { delete C.prototype[win.Symbol.iterator]; del.push(ctor + '[Symbol.iterator]'); }
        catch { /* non-configurable */ }
      }
      // forEach on NodeList is Chrome 51 too; HTMLCollection never had one.
      if (C && C.prototype && C.prototype.forEach) {
        try { delete C.prototype.forEach; del.push(ctor + '#forEach'); } catch { /* */ }
      }
      if (C && C.prototype && C.prototype.entries) {
        try { delete C.prototype.entries; delete C.prototype.keys; delete C.prototype.values; } catch { /* */ }
      }
    }
  }

  // Chrome 38 has EventTarget, but `new EventTarget()` only works from Chrome
  // 64: before that it throws "Illegal constructor", and custom-event-target.ts
  // falls back to its stand-in. Left constructible here, with Reflect removed
  // above, Babel's `class extends EventTarget` threw instead, and the Tracking
  // Block's fetch hook never ran in any legacy test.
  if (win.EventTarget) {
    const proto = win.EventTarget.prototype;
    const Illegal = function EventTarget() { throw new win.TypeError('Illegal constructor'); };
    Illegal.prototype = proto;
    win.EventTarget = Illegal;
    del.push('new EventTarget()');
  }
  // The event constructors the app uses are left as they are: Chrome 38 has
  // them all (MDN browser-compat-data: Event and CustomEvent from Chrome 15;
  // MouseEvent, KeyboardEvent, FocusEvent, UIEvent and WheelEvent from 26).
  // So keyboard-search.js's document.createEvent('MouseEvents') fallback does
  // not run on a webOS 3 TV either.

  // Chrome 38 has Element#webkitMatchesSelector; restore it so polyfills.js can find it.
  if (!win.Element.prototype.matches) {
    win.Element.prototype.webkitMatchesSelector = function (sel) {
      const list = (this.ownerDocument || win.document).querySelectorAll(sel);
      for (let i = 0; i < list.length; i++) if (list[i] === this) return true;
      return false;
    };
  }
  return del;
}
module.exports = { applyChrome38Downgrade };

/**
 * Chrome 87 / webOS 22 environment: removes the JS built-ins and DOM APIs
 * Chromium 87 does not ship, for the modern bundle (the oldest TV it serves
 * is webOS 22). That build has no polyfills, so a bundle that uses one of
 * these throws on the TV; without this it passed on Node 22.
 *
 * "First Chrome version" from MDN browser-compat-data. Syntax (class static
 * blocks 94, the RegExp v flag 112, ...) cannot be removed here; babel's
 * `chrome 87` target lowers it.
 */
function applyChrome87Downgrade(win) {
  const del = [];
  const rm = (obj, prop, label) => {
    if (obj && prop in obj) {
      try { delete obj[prop]; if (!(prop in obj)) del.push(label); } catch { /* non-configurable */ }
    }
  };
  const A = win.Array.prototype;
  rm(A, 'at', 'Array#at');                                // Chrome 92
  rm(A, 'findLast', 'Array#findLast');                    // Chrome 97
  rm(A, 'findLastIndex', 'Array#findLastIndex');          // Chrome 97
  rm(A, 'toSorted', 'Array#toSorted');                    // Chrome 110
  rm(A, 'toReversed', 'Array#toReversed');                // Chrome 110
  rm(A, 'toSpliced', 'Array#toSpliced');                  // Chrome 110
  rm(A, 'with', 'Array#with');                            // Chrome 110
  rm(win.Array, 'fromAsync', 'Array.fromAsync');          // Chrome 121
  rm(win.String.prototype, 'at', 'String#at');            // Chrome 92
  rm(win.String.prototype, 'isWellFormed', 'String#isWellFormed'); // Chrome 111
  rm(win.String.prototype, 'toWellFormed', 'String#toWellFormed'); // Chrome 111
  rm(win.Object, 'hasOwn', 'Object.hasOwn');              // Chrome 93
  rm(win.Object, 'groupBy', 'Object.groupBy');            // Chrome 117
  rm(win.Map, 'groupBy', 'Map.groupBy');                  // Chrome 117
  rm(win.Promise, 'withResolvers', 'Promise.withResolvers'); // Chrome 119
  for (const m of ['union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom']) {
    rm(win.Set.prototype, m, 'Set#' + m);                 // Chrome 122
  }
  const typed = win.Uint8Array && Object.getPrototypeOf(win.Uint8Array.prototype);
  for (const m of ['at', 'findLast', 'findLastIndex', 'toSorted', 'toReversed', 'with']) {
    rm(typed, m, 'TypedArray#' + m);                      // Chrome 92-110
  }
  rm(win, 'structuredClone', 'structuredClone');          // Chrome 98
  if (win.AbortSignal) {
    rm(win.AbortSignal, 'timeout', 'AbortSignal.timeout'); // Chrome 103
    rm(win.AbortSignal, 'any', 'AbortSignal.any');         // Chrome 116
    rm(win.AbortSignal.prototype, 'throwIfAborted', 'AbortSignal#throwIfAborted'); // Chrome 100
  }
  if (win.crypto) rm(win.crypto, 'randomUUID', 'crypto.randomUUID'); // Chrome 92
  rm(win.Element.prototype, 'checkVisibility', 'Element#checkVisibility'); // Chrome 105
  rm(win.HTMLElement.prototype, 'showPopover', 'HTMLElement#showPopover'); // Chrome 114
  return del;
}
module.exports.applyChrome87Downgrade = applyChrome87Downgrade;

/**
 * jsdom 30 removed the top-level `userAgent` constructor option, so setting it
 * there silently does nothing and every "legacy" test would actually run as
 * webOS 6 - skipping the emoji, buffer-limit and legacy-emoji code paths
 * entirely. Override navigator.userAgent directly instead.
 */
const UA = {
  webos3: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/38.0.2125.122 Safari/537.36 WebAppManager webOS.TV-2016',
  webos4: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36 WebAppManager webOS.TV-2018',
  webos23: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.31 Safari/537.36 WebAppManager webOS.TV-2023'
};

function setUserAgent(win, ua) {
  Object.defineProperty(win.navigator, 'userAgent', {
    value: ua, configurable: true, writable: false
  });
  if (win.navigator.userAgent !== ua) throw new Error('failed to override userAgent');
}

/**
 * Simulates the *worse* Chromium 38 case: DOM collections are not iterable AND
 * their prototypes reject a Symbol-keyed defineProperty, so a polyfill cannot
 * install one. Old Blink does this for some host prototypes, which is why
 * patching HTMLCollection.prototype did not fix Settings-panel navigation on a
 * real webOS 3 TV even though it fixed the simulation.
 *
 * Code that survives this does not depend on DOM collections being iterable at
 * all - which is the only guarantee available on hardware we cannot test.
 */
function sealDomCollectionPrototypes(win) {
  const sealed = [];
  for (const ctor of ['NodeList', 'HTMLCollection', 'DOMTokenList', 'NamedNodeMap']) {
    const C = win[ctor];
    if (!C || !C.prototype) continue;
    Object.preventExtensions(C.prototype);
    sealed.push(ctor);
  }
  return sealed;
}

module.exports.sealDomCollectionPrototypes = sealDomCollectionPrototypes;
module.exports.UA = UA;
module.exports.setUserAgent = setUserAgent;

// jsdom's wrapper <-> implementation helpers. Internal, so their path moved
// between major versions (30 put the generated code under lib/generated/idl).
function jsdomUtils() {
  for (const p of ['jsdom/lib/generated/idl/utils.js', 'jsdom/lib/jsdom/living/generated/utils.js']) {
    try { return require(p); } catch { /* try the next layout */ }
  }
  throw new Error('jsdom internals not found: dispatchTrusted needs updating for this jsdom');
}

/**
 * Dispatches `event` on `target` as a trusted event, the way a key press on the
 * remote arrives. The app ignores key events with isTrusted false (src/ui.js
 * isSyntheticKey), so page script cannot trigger its shortcuts; jsdom's
 * dispatchEvent() always marks the event untrusted, so a test pressing a key
 * that way is ignored. jsdom's internal dispatch keeps the flag as set here.
 */
function dispatchTrusted(target, event) {
  const { implForWrapper } = jsdomUtils();
  const eventImpl = implForWrapper(event);
  eventImpl.isTrusted = true;
  return implForWrapper(target)._dispatch(eventImpl);
}

module.exports.dispatchTrusted = dispatchTrusted;
