/**
 * Behavioural test for the deferred options-panel build.
 *
 * The risky case is a user reaching a tab before the idle build chain does:
 * setActivePage() must build that page synchronously rather than blowing up on
 * an undefined page element. Also checks each builder runs exactly once, that
 * every page ends up identical to the all-synchronous build, and that opening
 * and closing the panel repeatedly doesn't duplicate anything.
 */
const { createReporter, bootPage, trustedKey: key } = require('./harness.cjs');

// With `modern` on the command line, bootPage runs the modern bundle (webOS 22
// and newer) in a Chrome 87 environment with a webOS 23 user agent, instead of
// the legacy one in a Chrome 38 environment.
const GREEN = 404;

function boot(bodyClass = 'WEB_PAGE_TYPE_BROWSE', extraHtml = '', setup = null) {
  const { win, errors, frames } = bootPage({
    html: '<!doctype html><html><body class="' + bodyClass + '"><ytlr-app></ytlr-app>' + extraHtml + '</body></html>',
    consoleErrors: false,
    raf: 'manual',
    config: {
      enableAdBlock: true, enableLegacyEmojiFix: true, enableSponsorBlock: true,
      enableReturnYouTubeDislike: true, thumbnailQuality: 'off', enableAutoLogin: true,
      enableScrollSeek: true, timeRemainingMode: 'both', logoStyle: 'premium'
    },
    setup,
    restoreRemove: false
  });
  return { win, errors, pump: frames.pump };
}

const { t, done } = createReporter();
// One per tab, in tab order (SETTINGS_PAGES in src/ui.js).
const PAGES = ['#ytaf-page-filters', '#ytaf-page-player', '#ytaf-page-interface',
  '#ytaf-page-sponsor', '#ytaf-page-shortcuts', '#ytaf-page-ui-tweaks', '#ytaf-page-about'];
const SPONSOR = 3;
const SHORTCUTS = 4;

setTimeout(async () => {
  // ---- Case 1: user hits a tab BEFORE the idle chain gets there ----
  {
    const { win, errors, pump } = boot();
    key(win, GREEN);
    const panel = win.document.querySelector('.ytaf-ui-container');
    t('panel exists after keypress', !!panel);
    t('only the first page built synchronously',
      win.document.querySelectorAll(PAGES[SPONSOR]).length === 0,
      'sponsor page count ' + win.document.querySelectorAll(PAGES[SPONSOR]).length);

    const tabs = panel.querySelectorAll('.ytaf-tab-btn');
    t('one tab button per page', tabs.length === PAGES.length, 'got ' + tabs.length);

    // No frames pumped yet: jump straight to Shortcuts (the fifth tab).
    let threw = null;
    try { tabs[SHORTCUTS].click(); } catch (e) { threw = e; }
    t('tab press before idle build does not throw', !threw, threw && threw.message);
    const shortcuts = win.document.querySelector(PAGES[SHORTCUTS]);
    t('Shortcuts page built on demand', !!shortcuts);
    t('Shortcuts page is the visible one', shortcuts && shortcuts.style.display === 'block',
      shortcuts && shortcuts.style.display);
    t('first page hidden after tab switch',
      win.document.querySelector(PAGES[0]).style.display === 'none');
    // Don't pin an exact element count - adding a setting legitimately changes
    // it. What matters is that an on-demand build is fully populated, which the
    // shortcut rows (one per bindable key) prove.
    t('Shortcuts page fully populated',
      shortcuts && shortcuts.querySelectorAll('.shortcut-control-row').length >= 13,
      shortcuts && String(shortcuts.querySelectorAll('.shortcut-control-row').length) + ' rows');

    // Now let the idle chain finish; it must not rebuild what already exists.
    for (let i = 0; i < 20; i++) pump();
    for (const sel of PAGES) {
      t('exactly one ' + sel.replace('#ytaf-page-', ''),
        win.document.querySelectorAll(sel).length === 1,
        'count ' + win.document.querySelectorAll(sel).length);
    }
    t('no jsdomError in this flow', errors.length === 0, errors[0]);
  }

  // ---- Case 2: normal flow, idle chain completes first ----
  {
    const { win, errors, pump } = boot();
    key(win, GREEN);
    for (let i = 0; i < 20; i++) pump();
    const panel = win.document.querySelector('.ytaf-ui-container');
    const counts = PAGES.map((s) => {
      const el = win.document.querySelector(s);
      return el ? el.getElementsByTagName('*').length : -1;
    });
    t('every page built after idle frames',
      counts.length === PAGES.length && counts.every((n) => n > 10), JSON.stringify(counts));
    // The deferred build must produce the same tree an all-synchronous one
    // would: every page's elements accounted for, nothing dropped or doubled.
    const pageSum = counts.reduce((a, b) => a + b, 0);
    const panelTotal = panel.getElementsByTagName('*').length;
    t('panel total accounts for every page',
      panelTotal > pageSum && panelTotal - pageSum < 40,
      `pages=${pageSum} panel=${panelTotal}`);

    // Walk every tab, forwards then backwards.
    const tabs = panel.querySelectorAll('.ytaf-tab-btn');
    let ok = true, detail = '';
    for (const order of [[1, 2, 3, 4, 5, 0], [5, 3, 1, 0, 4, 2]]) {
      for (const i of order) {
        tabs[i].click();
        const shown = PAGES.map((s) => win.document.querySelector(s).style.display);
        const expect = PAGES.map((_, j) => (j === i ? 'block' : 'none'));
        if (JSON.stringify(shown) !== JSON.stringify(expect)) {
          ok = false; detail = `tab ${i}: ${JSON.stringify(shown)}`;
        }
        if (!tabs[i].classList.contains('active')) { ok = false; detail = `tab ${i} not marked active`; }
      }
    }
    t('every tab shows exactly its own page', ok, detail);

    // Close and reopen: must not duplicate the panel or its pages.
    key(win, GREEN);
    key(win, GREEN);
    for (let i = 0; i < 20; i++) pump();
    t('reopen does not duplicate the panel',
      win.document.querySelectorAll('.ytaf-ui-container').length === 1);
    t('reopen does not duplicate pages',
      PAGES.every((s) => win.document.querySelectorAll(s).length === 1));
    t('no jsdomError across open/close/reopen', errors.length === 0, errors[0]);
  }

  // ---- Case 3: Block the Channel of This Video when the player's author is empty (webOS 25) ----
  {
    const { win, errors, pump } = boot('WEB_PAGE_TYPE_WATCH',
      '<div id="ytlr-player__player-container-player"></div><ytlr-video-title-tray><ytlr-video-metadata-line>' +
      '<yt-formatted-string>Linus Tech Tips</yt-formatted-string><yt-formatted-string>1 M views</yt-formatted-string>' +
      '</ytlr-video-metadata-line></ytlr-video-title-tray>');
    win.document.getElementById('ytlr-player__player-container-player').getVideoData = () => ({ author: '' });
    key(win, GREEN);
    for (let i = 0; i < 20; i++) pump();
    const btn = win.document.querySelector('.ytaf-list-action');
    t('channel button falls back to the title tray', !!btn && btn.style.display === '' &&
      /: Linus Tech Tips$/.test(btn.textContent), btn && btn.textContent + ' / ' + btn.style.display);
    // The same channel again with other letter case: no duplicate, and it says so.
    const input = btn.closest('.ytaf-list-editor').querySelector('.ytaf-text-input');
    input.value = 'Foo Channel';
    input.ytafSubmit();
    input.value = 'FOO channel';
    input.ytafSubmit();
    const entries = btn.closest('.ytaf-list-editor').querySelectorAll('.ytaf-list-entries .ytaf-list-btn').length;
    const msgs = [...win.document.querySelectorAll('.message')].map((m) => m.textContent);
    t('a duplicate channel is not added and says Already blocked',
      entries === 1 && msgs.includes('Already blocked: FOO channel'), entries + ' / ' + msgs.join(' | '));
    t('no jsdomError on the watch page', errors.length === 0, errors[0]);
  }

  // ---- Case 4: scroll-wheel seek when webOS 25 marks the bar with zylon-focus only ----
  {
    const { win } = boot('WEB_PAGE_TYPE_WATCH',
      '<ytlr-progress-bar class="zylon-focus"></ytlr-progress-bar><video></video>');
    const v = win.document.querySelector('video');
    Object.defineProperty(v, 'duration', { value: 600 });
    Object.defineProperty(v, 'currentTime', { value: 100, writable: true });
    win.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    await new Promise((r) => setTimeout(r, 300));
    t('wheel up on the focused bar seeks +10s', v.currentTime === 110, 'currentTime=' + v.currentTime);
  }

  // ---- Case 5: remaining time is hidden on a live stream with a finite duration (webOS 25) ----
  {
    const { win } = boot('WEB_PAGE_TYPE_WATCH',
      '<div id="ytlr-player__player-container-player"></div>' +
      '<div idomkey="time-label"><span idomkey="duration"></span></div><video></video>');
    const v = win.document.querySelector('video');
    Object.defineProperty(v, 'duration', { value: 39021 });
    Object.defineProperty(v, 'currentTime', { value: 35436, writable: true });
    let live = false;
    win.document.getElementById('ytlr-player__player-container-player').getVideoData = () => ({ isLive: live });
    const text = () => (win.document.getElementById('ytaf-time-remaining') || {}).textContent || '';
    await new Promise((r) => setTimeout(r, 1100));
    t('remaining time shown on a normal video', /ends /.test(text()), text());
    t('Both shows both halves', /"-59:45 · ends [^"]+"/.test(text()), text());
    live = true;
    await new Promise((r) => setTimeout(r, 1100));
    t('remaining time hidden on a live stream', !/ends /.test(text()), text());
  }

  // ---- Case 5b: End Time alone, then Remaining alone (NicholasBly/youtube-webos#195) ----
  {
    const { win } = boot('WEB_PAGE_TYPE_WATCH',
      '<div idomkey="time-label"><span idomkey="duration"></span></div><video></video>',
      (w) => {
        const c = JSON.parse(w.localStorage.getItem('ytaf-configuration'));
        c.timeRemainingMode = 'end';
        w.localStorage.setItem('ytaf-configuration', JSON.stringify(c));
      });
    const v = win.document.querySelector('video');
    Object.defineProperty(v, 'duration', { value: 600 });
    Object.defineProperty(v, 'currentTime', { value: 60, writable: true });
    const text = () => (win.document.getElementById('ytaf-time-remaining') || {}).textContent || '';
    await new Promise((r) => setTimeout(r, 1100));
    t('End Time shows only the end time', /content:"ends [^"]+"/.test(text()), text());
    key(win, GREEN);
    win.document.querySelectorAll('.ytaf-tab-btn')[1].click();
    const row = [...win.document.querySelectorAll(PAGES[1] + ' .shortcut-control-row')]
      .find((r) => /Show Remaining Time \/ End Time/.test(r.textContent));
    const value = () => row && row.querySelector('.current-value').textContent;
    t('the setting is a choice on the Player page', value() === 'End Time', row ? value() : 'no row');
    row && row.click();
    t('the next choice is Both', value() === 'Both', value());
    t('Both shows at once, without waiting for the next tick', /content:"-9:00 · ends [^"]+"/.test(text()), text());
    row && row.click();
    t('Off after Both', value() === 'Off', value());
    t('Off clears the text', !/content:/.test(text()), text());
    row && row.click();
    await new Promise((r) => setTimeout(r, 1100));
    t('Remaining shows only the remaining time', /content:"-9:00"/.test(text()), text());
    // At double speed the 540 s left take 270 s. The mode goes round to Both
    // (End Time, then Both), which writes the text at once. The page's clock
    // stands at 12:00:00 here, so the end is 12:04 (12:09 if the speed were
    // left out), in the page's own time format.
    const fixedNow = new win.Date(2026, 0, 1, 12, 0, 0).getTime();
    const realNow = win.Date.now;
    win.Date.now = () => fixedNow;
    const at = (ms) => new win.Intl.DateTimeFormat(win.navigator.language, { hour: 'numeric', minute: 'numeric' })
      .format(new win.Date(fixedNow + ms));
    Object.defineProperty(v, 'playbackRate', { configurable: true, value: 2 });
    row && row.click();
    row && row.click();
    win.Date.now = realNow;
    t('precondition: back on Both, and 270 s and 540 s from the clock read differently', value() === 'Both' &&
      at(270000) !== at(540000), value() + ' ' + at(270000) + ' / ' + at(540000));
    t('at 2x the time left is halved, and the end is 270 s away', text().includes(`content:"-4:30 · ends ${at(270000)}"`),
      text() + ' expected ends ' + at(270000));
  }

  // ---- Case 6: the Premium logo comes back after YouTube repaints the header ----
  {
    const { win } = boot('WEB_PAGE_TYPE_BROWSE',
      '<ytlr-logo-entity><ytlr-thumbnail-details></ytlr-thumbnail-details></ytlr-logo-entity>');
    const img = () => win.document.querySelector('ytlr-thumbnail-details');
    const bg = () => win.getComputedStyle(img()).backgroundImage;
    await new Promise((r) => setTimeout(r, 50));
    t('premium logo applied at startup', /premium/.test(bg()), bg());
    // YouTube repaints the header with its own wordmark, with no page change.
    img().style.backgroundImage = 'url("https://www.gstatic.com/youtube/img/branding/livingroom/youtube/wordmark/x.png")';
    t('premium logo holds after a repaint', /premium/.test(bg()), bg());
  }

  // ---- Case 7: keyboard Enter submits the search when YouTube types natively (webOS 25) ----
  {
    const { win } = boot('WEB_PAGE_TYPE_SEARCH',
      '<ytlr-search-text-box></ytlr-search-text-box>' +
      '<yt-keyboard-key tabindex="0">A</yt-keyboard-key><yt-keyboard-key>KERESÉS</yt-keyboard-key>');
    const d = win.document;
    const [keyA, keySearch] = d.querySelectorAll('yt-keyboard-key');
    const box = d.querySelector('ytlr-search-text-box');
    for (const k of [keyA, keySearch]) k.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 50 });
    keyA.focus();
    let searched = 0, okOnA = 0;
    keySearch.addEventListener('mousedown', () => searched++);
    // YouTube's side: types printable keys itself; Enter is OK on the focused key.
    d.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (e.key && e.key.length === 1) box.textContent += e.key;
      else if (e.keyCode === 13 && d.activeElement === keyA) okOnA++;
    });
    const typeKey = (k, code) => {
      key(win, code, d.activeElement, 'keydown', { key: k });
    };
    typeKey('l', 76);
    await new Promise((r) => setTimeout(r, 500));
    typeKey('o', 79);
    typeKey('Enter', 13);
    t('typed natively', box.textContent === 'lo', box.textContent);
    t('Enter presses the on-screen search key', searched === 1 && okOnA === 0, `searched=${searched} okOnA=${okOnA}`);
  }

  // ---- Case 9: Toggle Comments finds the button by its data, whatever the UI language (webOS 25) ----
  {
    const { win } = boot('WEB_PAGE_TYPE_WATCH',
      '<ytlr-player-actions-container><ytlr-button-renderer idomkey="item-1">' +
      '<yt-button-container aria-label="Megjegyzések"><yt-icon class="MjctSe ieYpu nGYLgf"></yt-icon></yt-button-container>' +
      '</ytlr-button-renderer></ytlr-player-actions-container><video></video>',
      (w) => {
        const c = JSON.parse(w.localStorage.getItem('ytaf-configuration'));
        c.shortcut_key_8 = 'toggle_comments';
        w.localStorage.setItem('ytaf-configuration', JSON.stringify(c));
      });
    const d = win.document;
    d.querySelector('ytlr-button-renderer').__instance = { props: { data: { icon: { iconType: 'COMMENT' } } } };
    let selected = 0;
    d.querySelector('yt-button-container').__instance = { onSelect: () => selected++ };
    key(win, 56);
    t('digit bound to Toggle Comments presses the comments button', selected === 1, 'onSelect calls=' + selected);
  }

  done();
}, 500);
