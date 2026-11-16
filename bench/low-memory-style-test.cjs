/**
 * Remove Black Text Boxes (app-quality-fix.js, from NicholasBly/youtube-webos#215):
 * YouTube's low-memory class comes off <body> at start and each time YouTube
 * puts it back, the setting turned off gives it back, and with it off from the
 * start the class is left alone. OLED-Care's rules for those elements no longer
 * need the class.
 *
 *   node bench/low-memory-style-test.cjs <bundle> [legacy|modern]
 *
 * `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87
 * environment, instead of the legacy one in a Chrome 38 one. Both run with a
 * webOS 23 user agent.
 */
const { createReporter, bootPage, trustedKey, wait, UA } = require('./harness.cjs');

const GREEN = 404;
const CLS = 'app-quality-root';

function boot(cfg) {
  const { win, errors } = bootPage({
    bodyClass: `WEB_PAGE_TYPE_BROWSE ${CLS}`,
    userAgent: UA.webos23,
    consoleErrors: false,
    config: Object.assign({
      enableAdBlock: false, enableLegacyEmojiFix: false, enableSponsorBlock: false,
      enableReturnYouTubeDislike: false, upgradeThumbnails: false, enableAutoLogin: false,
      checkForUpdates: false, showWhatsNew: false
    }, cfg),
    // A frame is a 0 ms timer of node's, called without a time.
    raf: (cb) => setTimeout(cb, 0),
    fetch: 'pending'
  });
  const has = () => win.document.body.classList.contains(CLS);
  const openPanel = () => {
    trustedKey(win, GREEN);
    const tab = [...win.document.querySelectorAll('.ytaf-tab-btn')].find((b) => b.textContent.trim() === 'UI Tweaks');
    if (tab) tab.click();
  };
  // The panel's Remove Black Text Boxes checkbox, set as the remote would.
  const setBox = (on) => {
    const label = [...win.document.querySelectorAll('.ytaf-ui-container label')]
      .find((l) => l.textContent.trim() === 'Remove Black Text Boxes');
    const box = label && label.querySelector('input[type=checkbox]');
    if (!box) return false;
    box.checked = on;
    box.dispatchEvent(new win.Event('change', { bubbles: true }));
    return true;
  };
  return { win, errors, has, openPanel, setBox };
}

const { t, run } = createReporter();

run(async () => {
  {
    const { win, errors, has, openPanel, setBox } = boot({});
    await wait(20);
    t('on by default: the class is off <body> at start', !has());
    t('the page\'s own classes stay', win.document.body.classList.contains('WEB_PAGE_TYPE_BROWSE'));

    // YouTube writes body.className whole on navigation.
    win.document.body.className = `WEB_PAGE_TYPE_WATCH ${CLS}`;
    await wait(20);
    t('a className rewrite with the class loses it again', !has());
    t('and keeps the rest of the rewrite', win.document.body.classList.contains('WEB_PAGE_TYPE_WATCH'));
    win.document.body.classList.add(CLS);
    await wait(20);
    t('a classList.add of it is taken off too', !has());

    openPanel();
    await wait(20);
    t('the setting is in the panel, checked', setBox(true));
    setBox(false);
    await wait(20);
    t('turned off: YouTube gets its class back', has());
    win.document.body.className = `WEB_PAGE_TYPE_BROWSE ${CLS}`;
    await wait(20);
    t('and keeps it after a rewrite', has());
    setBox(true);
    await wait(20);
    t('turned on again: the class goes', !has());
    win.document.body.className = `WEB_PAGE_TYPE_BROWSE ${CLS}`;
    await wait(20);
    t('and stays off after a rewrite', !has());
    t('no page errors', errors.length === 0, errors.join(' | '));
  }

  {
    const { win, errors, has } = boot({ removeLowMemoryStyle: false });
    await wait(20);
    t('off from the start: the class stays', has());
    win.document.body.className = 'WEB_PAGE_TYPE_WATCH';
    await wait(20);
    t('and is not put on a body that has none', !has());
    t('off: no page errors', errors.length === 0, errors.join(' | '));
  }

  {
    // OLED-Care's true black and transparent shelf, with the class gone.
    const { win } = boot({ enableOledCareMode: true, videoShelfOpacity: 100 });
    await wait(20);
    win.document.body.className = 'WEB_PAGE_TYPE_BROWSE';
    // YouTube's own grey backgrounds, for OLED-Care to override.
    win.document.body.insertAdjacentHTML('beforeend',
      '<style>.DnwJH, .UGcxnc .dxLAmd, .UGcxnc .Dc2Zic .JkDfAc { background-color: rgb(33, 33, 33); }</style>' +
      '<div class="DnwJH"></div><div class="UGcxnc"><div class="dxLAmd"></div>' +
      '<div class="Dc2Zic"><div class="JkDfAc"></div></div></div>');
    const bg = (sel) => win.getComputedStyle(win.document.querySelector(sel)).backgroundColor;
    t('OLED-Care: the element under the player is black without the class',
      /^(?:rgb\(0, 0, 0\)|#000)$/.test(bg('.DnwJH')), bg('.DnwJH'));
    t('OLED-Care: the transparent shelf without the class',
      /rgba\(0, 0, 0, 0\)|transparent/.test(bg('.dxLAmd')), bg('.dxLAmd'));
    t('OLED-Care: the shelf\'s inner backdrop too',
      /rgba\(0, 0, 0, 0\)|transparent/.test(bg('.JkDfAc')), bg('.JkDfAc'));
  }
});
