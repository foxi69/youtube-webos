/**
 * YouTube wordmark selection.
 *
 * YouTube ships two wordmarks and picks between them by account status:
 *
 *   premium  .../livingroom/premium/wordmark_truncated/fullcolor_white_57_2x_v2.png
 *   default  .../livingroom/youtube/wordmark/fullcolor_white_57_2x_v2.png
 *
 * They are different widths, and the header positions the element with an
 * absolute `left` that is calculated from that width, so swapping the image
 * alone leaves it misaligned. Both values are set together.
 *
 * Every style is a static stylesheet rule gated by a class on <html>, as
 * Hidden always was (its rule is in initGlobalStyles() in ui.js). YouTube
 * repaints the header with its own wordmark - after "Who's watching", and
 * when the app comes back from the background or after a long idle - and an
 * !important rule wins over the inline style it writes, so the chosen
 * wordmark survives every repaint without a poll or an observer. Writing the
 * element's own style did not: it was lost on a repaint that came with no
 * page change (NicholasBly/youtube-webos#214, fork watch #96).
 */
import { configRead, configAddChangeListener } from './config.js';

const HIDDEN_CLASS = 'ytaf-hide-logo';
const STYLE_ID = 'ytaf-logo-style';

const LOGO_VARIANTS = {
  default: {
    url: 'https://www.gstatic.com/youtube/img/branding/livingroom/youtube/wordmark/fullcolor_white_57_2x_v2.png',
    left: '66.375rem',
    width: '10.125rem'
  },
  premium: {
    url: 'https://www.gstatic.com/youtube/img/branding/livingroom/premium/wordmark_truncated/fullcolor_white_57_2x_v2.png',
    left: '65.75rem',
    width: '10.75rem'
  }
};

const variantClass = (name) => `ytaf-logo-${name}`;

function logoCss() {
  return Object.keys(LOGO_VARIANTS).map((name) => {
    const v = LOGO_VARIANTS[name];
    const scope = `html.${variantClass(name)} ytlr-logo-entity`;
    return `${scope} { left: ${v.left} !important; width: ${v.width} !important; }\n` +
      `${scope} ytlr-thumbnail-details { background-image: url("${v.url}") !important; }`;
  }).join('\n');
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = logoCss();
  (document.head || document.documentElement).appendChild(style);
}

/** Apply the configured style: one class on <html>, read by the stylesheet. */
export function applyLogoStyle() {
  const style = configRead('logoStyle');
  const root = document.documentElement.classList;
  root.toggle(HIDDEN_CLASS, style === 'hidden');
  // Own keys only: an inherited name (toString) is not a wordmark.
  const known = Object.prototype.hasOwnProperty.call(LOGO_VARIANTS, style);
  const variant = style === 'hidden' ? null : (known ? style : 'default');
  for (const name of Object.keys(LOGO_VARIANTS)) root.toggle(variantClass(name), name === variant);
}

export function initLogoStyle() {
  injectStyles();
  applyLogoStyle();
  configAddChangeListener('logoStyle', () => applyLogoStyle());
}
