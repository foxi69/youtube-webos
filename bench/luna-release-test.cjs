/**
 * lunaCall (src/webos-utils.js) keeps each call's bridge until it is done, so
 * the answer is not lost. Done includes a call cancelled and a subscription
 * the TV refused: neither gets more answers, and its bridge must not stay
 * held for the rest of the session. (A refusal ends the screensaver
 * subscription through its keep: bench/screensaver-cases-test.)
 *
 *   node bench/luna-release-test.cjs
 */
require('v8').setFlagsFromString('--expose-gc');
const gc = require('vm').runInNewContext('gc');
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const { createReporter } = require('./harness.cjs');

const { code } = babel.transformSync(fs.readFileSync(path.join(__dirname, '../src/webos-utils.js'), 'utf8'), {
  configFile: false, babelrc: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
});

let cancelled = 0;
globalThis.window = {
  navigator: { userAgent: '' },
  PalmServiceBridge: function PalmServiceBridge() {
    this.call = () => {};
    this.cancel = () => { cancelled++; };
  }
};
const mod = { exports: {} };
new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
const { lunaCall } = mod.exports;

const { t, run } = createReporter();

// Whether the bridge a call makes is collected once the test lets go of it.
async function collected(make) {
  let ref = make();
  ref = new WeakRef(ref);
  for (let i = 0; i < 5 && ref.deref(); i++) {
    await new Promise((r) => setTimeout(r, 10));
    gc();
  }
  return !ref.deref();
}

run(async () => {
  t('control: a subscription still going is held', !(await collected(() => lunaCall('luna://x/sub', {}, null, () => true))));
  t('a cancelled subscription is let go', await collected(() => {
    const b = lunaCall('luna://x/sub', {}, null, () => true);
    b.cancel();
    return b;
  }));
  t('cancel still reaches the bridge', cancelled === 1, String(cancelled));
  t('a subscription whose keep says no more is let go', await collected(() => {
    const b = lunaCall('luna://x/sub', {}, null, (res) => res.returnValue !== false);
    b.onservicecallback(JSON.stringify({ returnValue: false }));
    return b;
  }));
});
