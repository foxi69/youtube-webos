/**
 * Auto Login answering "Who's watching?" before it is shown (auto-login.js
 * answerAccountSelector): YouTube's startAccountSelectorCommand is given the
 * answer a pick of the same account gives, so the selector never comes up and
 * no key has to be pressed in time. auto-login-test covers the key presses
 * that stay for a selector that comes up all the same.
 *
 *   node bench/whos-watching-test.cjs <bundle> [legacy|modern]
 *
 * YouTube's command resolver is a stand-in in window._yttv that records what
 * reaches it. Not seen on a TV: the command's shape is as Bolli YouTube uses it.
 */
const { createReporter, bootPage, flavorFromArgs, wait } = require('./harness.cjs');

// `modern`: the modern bundle (webOS 22 and newer), in a Chrome 87 environment
// with a webOS 23 user agent, instead of the legacy one in a Chrome 38 one.
const { modern } = flavorFromArgs();
const { t, run } = createReporter();

const NEXT = { browseEndpoint: { browseId: 'FEtopics' } };
const selector = () => ({ startAccountSelectorCommand: { nextEndpoint: NEXT, other: 1 } });

async function boot(cfg) {
  // The messages as they are, without the harness's 'jsdomError: ' and
  // 'console.error: ' in front.
  const errors = [];
  const seen = [];
  const keys = [];
  const Resolver = function Resolver() {};
  Resolver.instance = { resolveCommand: (command, extra) => { seen.push({ command, extra }); return 'app'; } };
  const { win } = bootPage({
    url: 'https://www.youtube.com/tv#/',
    ignoreNavigation: true,
    onError: (text) => errors.push(text.replace(/^(?:jsdomError|console\.error): /, '')),
    config: Object.assign({
      enableAdBlock: false, enableSponsorBlock: false, enableReturnYouTubeDislike: false,
      enableDeArrow: false, upgradeThumbnails: false, checkForUpdates: false, showWhatsNew: false
    }, cfg),
    // Before the environment, which takes fetch away again on the legacy build.
    setup: (w) => { w.fetch = () => new Promise(() => {}); },
    beforeEval: (w) => {
      w.addEventListener('keydown', (e) => keys.push(e.keyCode), true);
      w._yttv = { resolver: Resolver };
    }
  });
  await wait(60);
  return { win, errors, seen, keys, resolve: (c, x) => Resolver.instance.resolveCommand(c, x) };
}

run(async () => {
  const f = modern ? 'modern' : 'legacy';
  const n = (s) => `${f}: ${s}`;

  {
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: true });
    const out = env.resolve(selector(), 'x');
    const got = env.seen[env.seen.length - 1].command;
    const id = got.onIdentityChanged || {};
    t(n('the selector command is answered, not passed on'), !('startAccountSelectorCommand' in got) && out === 'app', JSON.stringify(got));
    t(n('...as a pick of the same account'), id.isSameIdentity === true, JSON.stringify(id));
    t(n('...that carries on to the command\'s own next page'),
      !!id.identityActionContext && JSON.stringify(id.identityActionContext.nextEndpoint) === JSON.stringify(NEXT) &&
      id.identityActionContext.eventTrigger === 'ACCOUNT_EVENT_TRIGGER_WHOS_WATCHING', JSON.stringify(id.identityActionContext));
    t(n('...as a client action'), !!got.commandMetadata && got.commandMetadata.webCommandMetadata.clientAction === true);
    // The key presses of the other way of skipping it come 500 ms later (and
    // 200 ms after that for a guest): past both before looking.
    await wait(900);
    t(n('no key is pressed for it'), env.keys.length === 0, env.keys.join());

    // Once in the window after a start: opened again, it is the viewer's own doing.
    env.resolve(selector());
    const again = env.seen[env.seen.length - 1].command;
    t(n('the selector opened again by the viewer is shown'), 'startAccountSelectorCommand' in again, JSON.stringify(again));

    // Any other command is passed on as it is, with its extra.
    const other = { watchEndpoint: { videoId: 'abcdefghijk' } };
    env.resolve(other, 'extra');
    const last = env.seen[env.seen.length - 1];
    t(n('another command is passed on as it is'), last.command === other && last.extra === 'extra');
    t(n('answered: no page errors'), env.errors.length === 0, env.errors.join(' | '));
    env.win.close();
  }
  {
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: false });
    const cmd = selector();
    env.resolve(cmd, 'x');
    const last = env.seen[env.seen.length - 1];
    t(n('"always ask" on: the selector command is passed on'), last.command === cmd && last.extra === 'x', JSON.stringify(last.command));
    env.win.close();
  }
  {
    const env = await boot({ enableAutoLogin: false, autoSelectAccount: true });
    const cmd = selector();
    env.resolve(cmd);
    t(n('Bypass Nag Screens off: the selector command is passed on'), env.seen[env.seen.length - 1].command === cmd);
    env.win.close();
  }
  {
    // A command without the shape expected: passed on, no throw.
    const env = await boot({ enableAutoLogin: true, autoSelectAccount: true });
    const cmd = { startAccountSelectorCommand: null };
    let threw = null;
    try { env.resolve(cmd); } catch (e) { threw = e; }
    t(n('a selector command with nothing in it is passed on'), !threw && env.seen[env.seen.length - 1].command === cmd, threw && threw.message);
    env.win.close();
  }
});
