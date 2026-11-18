// Adapted from https://github.com/reisxd/TizenTube/blob/522f83cc012d5b1c75181b651e084a3afa280323/mods/resolveCommand.js

declare global {
  interface Window {
    _yttv?: Record<string, unknown>;
    // Debug toggle read by hooks/fetch.ts (set via devtools); optional.
    __ytaf_debug__?: boolean;
  }
}

export type ResolveCommandPayload = Record<string, unknown>;

interface ResolveCommand {
  (command: ResolveCommandPayload, extra?: unknown): unknown;
}

export interface ResolveCommandHook {
  (
    originalFn: ResolveCommand,
    payload: ResolveCommandPayload,
    extra: unknown
  ): unknown;
}

let registry: ResolveCommandRegistry | null = null;
let initializing: Promise<ResolveCommandRegistry> | null = null;
// When the lookup in `initializing` started (Date.now()).
let initializingSince = 0;
// Outside the registry: a hook set while the resolver is still looked for, or
// after a startup lookup ran out, is in place once a later lookup finds it.
const cmds = new Map<string, ResolveCommandHook>();

export class ResolveCommandRegistry {
  #originalFn: ResolveCommand;

  private resolveCommand = (
    command: Record<string, unknown>,
    extra?: unknown
  ) => {
    if (window.__ytaf_debug__) {
      console.group(`[${this.constructor.name}] Resolving`);
      console.debug(`Command:`);
      console.debug(command);
      console.debug(`Extra:`);
      console.debug(extra);
      console.groupEnd();
    }

    for (const [key, hook] of cmds) {
      if (key in command) {
        return hook(this.#originalFn, command, extra);
      }
    }

    return this.#originalFn(command, extra);
  };

  // Only getInstance() constructs, with a key getHookTarget() has just
  // checked.
  private constructor(hookTargetName: string) {
    const hookTarget = window._yttv![hookTargetName] as {
      instance: { resolveCommand: ResolveCommand };
    };

    this.#originalFn = hookTarget.instance.resolveCommand.bind(
      hookTarget.instance
    );

    hookTarget.instance.resolveCommand = this.resolveCommand;

    console.debug(`[${this.constructor.name}] Hooked:`, this.#originalFn);
  }

  private static checkHookTarget(targetName: string) {
    const target = window._yttv?.[targetName];

    return !!(
      target &&
      typeof target === 'function' &&
      'instance' in target &&
      // typeof null is 'object': a constructor whose instance is not made yet.
      typeof target.instance === 'object' &&
      target.instance !== null &&
      typeof (target.instance as Record<string, unknown>).resolveCommand ===
        'function'
    );
  }

  private static findHookTarget() {
    if (typeof window?._yttv !== 'object') return null;

    // A candidate whose getter throws is passed over; the scan fails with
    // that error only when no other candidate is the resolver.
    // Whether one threw is kept apart from what it threw (a getter may throw
    // false or undefined).
    let failed = false;
    let failure: unknown;
    for (const key in window._yttv) {
      try {
        if (this.checkHookTarget(key)) return key;
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;

    return null;
  }

  private static readonly POLL_TIMEOUT_MS = 30_000;
  private static readonly POLL_MAX_DELAY_MS = 1_000;

  private static async getHookTarget(): Promise<string> {
    const immediate = this.findHookTarget();
    if (immediate) return immediate;

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + this.POLL_TIMEOUT_MS;
      let delay = 16;

      const poll = () => {
        let hook: string | null;
        // A scan that throws (a YouTube getter) ends this lookup, so the
        // callers waiting on it are let go and a later one can start anew.
        try {
          hook = this.findHookTarget();
        } catch (error) {
          return reject(error);
        }
        if (hook) return resolve(hook);

        if (Date.now() >= deadline) {
          return reject(
            new Error(
              `No resolveCommand hook target in window._yttv after ${this.POLL_TIMEOUT_MS}ms`
            )
          );
        }

        delay = Math.min(delay * 2, this.POLL_MAX_DELAY_MS);
        setTimeout(poll, delay);
      };

      setTimeout(poll, delay);
    });
  }

  static async getInstance(retry = true): Promise<ResolveCommandRegistry> {
    if (registry) return registry;

    // Startup consumers share one bounded discovery loop. A failed lookup
    // must be released too, so a later user action can try again.
    const calledAt = Date.now();
    if (!initializing) {
      initializingSince = calledAt;
      initializing = this.getHookTarget()
        .then((key) => (registry = registry ?? new ResolveCommandRegistry(key)))
        .then(
          (ready) => { initializing = null; return ready; },
          (error) => { initializing = null; throw error; }
        );
    }
    const since = initializingSince;
    try {
      return await initializing;
    } catch (error) {
      // A caller that joined a lookup with less than half of its window left
      // (a user action late after startup) gets one fresh lookup, shared with
      // whoever comes then. The startup consumers, there from the start, do not.
      if (retry && calledAt - since > this.POLL_TIMEOUT_MS / 2) return this.getInstance(false);
      throw error;
    }
  }

  /**
   * Sets hooks by command key, and returns the lookup, for its failure. The
   * hooks hold whenever the resolver is found, also by a later lookup.
   */
  static setHooks(hooks: Record<string, ResolveCommandHook>) {
    for (const key of Object.keys(hooks)) cmds.set(key, hooks[key]!);
    return this.getInstance();
  }

  dispatchCommand(payload: ResolveCommandPayload, extra?: unknown) {
    return this.#originalFn(payload, extra);
  }
}

ResolveCommandRegistry.getInstance().catch((e) => {
  console.warn('[app_api] resolveCommand hook unavailable:', e);
});