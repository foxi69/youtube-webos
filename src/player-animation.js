import { configRead, configAddChangeListener } from './config.js';

/**
 * Open Playing Previews Without Reloading, second half: YouTube's player
 * resize animation (featureSwitches.supportsPlayerResizeAnimation), off for
 * TVs. With it on, a preview that OK hands over grows from the tile to full
 * screen, and on a webOS 25 TV OK handed the preview over far more often:
 * 10 of 17 tries against 2 of 9 with the flag cleared alone (adblock.js,
 * fixPreviewCommands). On only with that setting. (From Zucchiniii's fork,
 * player-animation.ts, fork watch #139.)
 *
 * YouTube reads the switch each time it lays out the player, so the live
 * config is patched; the accessor keeps it so when YouTube replaces it.
 */
const SWITCH = 'supportsPlayerResizeAnimation';

let current = window.tectonicConfig;
// What YouTube had, to give it back when the setting goes off.
let original;

function apply() {
  const config = current;
  if (!config || typeof config !== 'object') return;
  if (!config.featureSwitches || typeof config.featureSwitches !== 'object') config.featureSwitches = {};
  const switches = config.featureSwitches;
  if (configRead('continuePreviews')) {
    if (original === undefined) original = { had: SWITCH in switches, value: switches[SWITCH] };
    switches[SWITCH] = true;
  } else if (original !== undefined) {
    if (original.had) switches[SWITCH] = original.value;
    else delete switches[SWITCH];
    original = undefined;
  }
}

apply();
try {
  Object.defineProperty(window, 'tectonicConfig', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (value) => {
      current = value;
      original = undefined;
      apply();
    }
  });
} catch (err) {
  console.warn('[PreviewHandover] tectonicConfig cannot be watched:', err);
}
configAddChangeListener('continuePreviews', apply);
