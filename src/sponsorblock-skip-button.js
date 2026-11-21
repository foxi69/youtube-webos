/**
 * The Skip button of a segment set to Manual Skip: bottom right, above the
 * player's controls, where YouTube puts the Skip button of an ad, while the
 * playhead is in the segment. It says which key skips it (Blue by default,
 * whatever key Manual Skip / Jump to Highlight is set to), and the Magic
 * Remote pointer can click it, for remotes with no colour buttons. It never
 * takes the remote's focus.
 *
 * It took the place of the "Press Blue to skip" notification in the top
 * right corner, where a viewer does not look for a skip.
 *
 * It follows the player, not the screen: a player made smaller (a side panel
 * open beside it) keeps the button in its own bottom right, a fifth of its
 * height up; one that is not on screen hides it. Looked at twice a second
 * while the button is shown (only during a Manual Skip segment).
 */
import { configRead } from './config.js';
import './sponsorblock-skip-button.css';

const KEY_NAMES = { red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue' };
const FOLLOW_MS = 500;
// Its place in the player: from the right edge, and up from the bottom (above
// the controls), as parts of the player's size.
const RIGHT_OF_WIDTH = 0.025;
const UP_OF_HEIGHT = 0.2;

function findPlayer() {
  return document.getElementById('ytlr-player__player-container-player') ||
    document.querySelector('.html5-video-player') || document.querySelector('video');
}

/** Puts the button in the player's bottom right; hidden while the player is not on screen. */
function place(button) {
  const player = findPlayer();
  const rect = player && player.getBoundingClientRect ? player.getBoundingClientRect() : null;
  const viewW = window.innerWidth || document.documentElement.clientWidth || (rect && rect.right);
  const viewH = window.innerHeight || document.documentElement.clientHeight || (rect && rect.bottom);
  if (!rect || rect.width < 1 || rect.height < 1 ||
      rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewW || rect.top >= viewH) {
    button.style.display = 'none';
    return;
  }
  button.style.display = '';
  button.style.right = `${Math.max(0, viewW - rect.right + rect.width * RIGHT_OF_WIDTH)}px`;
  button.style.bottom = `${Math.max(0, viewH - rect.bottom + rect.height * UP_OF_HEIGHT)}px`;
}

/** The key set to Manual Skip / Jump to Highlight, as the button names it, or '' for none. */
function skipKeyName() {
  for (const color of ['blue', 'red', 'green', 'yellow']) {
    if (configRead(`shortcut_key_${color}`) === 'sb_manual_skip') return KEY_NAMES[color];
  }
  for (let i = 0; i < 10; i++) {
    if (configRead(`shortcut_key_${i}`) === 'sb_manual_skip') return String(i);
  }
  return '';
}

/**
 * Shows the button for the segment named `title`; onSkip runs on a click.
 * Returns { remove }, as a notification's handle does.
 */
export function showSkipButton(title, onSkip) {
  const button = document.createElement('div');
  button.className = 'ytaf-sb-skip-button';
  const label = document.createElement('span');
  label.className = 'ytaf-sb-skip-label';
  label.textContent = `Skip ${title}`;
  button.appendChild(label);
  const key = skipKeyName();
  if (key) {
    const hint = document.createElement('span');
    hint.className = `ytaf-sb-skip-key ytaf-sb-skip-key-${key.toLowerCase()}`;
    hint.textContent = key;
    button.appendChild(hint);
  }
  button.addEventListener('click', (evt) => {
    evt.stopPropagation();
    evt.preventDefault();
    try { onSkip(); } catch (e) { console.warn('[SponsorBlock] Skip button failed:', e); }
  });
  (document.body || document.documentElement).appendChild(button);
  place(button);
  const follow = setInterval(() => place(button), FOLLOW_MS);
  return {
    remove() {
      clearInterval(follow);
      if (button.parentNode) button.parentNode.removeChild(button);
    }
  };
}
