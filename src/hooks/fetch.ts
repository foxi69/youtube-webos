import { CustomEventTarget, TypedCustomEvent, captureOf, type EventListenerArg } from '../custom-event-target';

export interface StringConvertible {
  toString(): string;
}

export type FetchTarget = Request | StringConvertible;

let registry: FetchRegistry | null = null;

type HookedType = 'request' | 'response';

const isHookedType = (t: unknown): t is HookedType =>
  t === 'request' || t === 'response';

export interface RequestInfo {
  url: URL;
  resource: FetchTarget;
  init?: RequestInit | undefined;
}

interface EventMap {
  request: CustomEvent<RequestInfo>;
  response: CustomEvent<Response>;
}

export class FetchRegistry extends CustomEventTarget<EventMap> {
  #originalFetch: typeof fetch;
  #fetchCount = 0;
  // By capture mode, [bubble, capture]: the browser keeps a callback once per
  // mode, so removing one registration can leave the other. A `once` or
  // `signal` listener the browser drops by itself stays here: that only keeps
  // the slower path, while a listener the browser has is never missing here.
  #listeners: Record<HookedType, [Set<unknown>, Set<unknown>]> = {
    request: [new Set(), new Set()],
    response: [new Set(), new Set()]
  };

  #hasListeners(type: HookedType) {
    const [bubble, capture] = this.#listeners[type];
    return bubble.size + capture.size > 0;
  }

  override addEventListener<K extends keyof EventMap>(
    type: K,
    callback: EventListenerArg<this, EventMap, K>,
    options?: boolean | AddEventListenerOptions
  ): void;
  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void;
  override addEventListener(type: any, callback: any, options?: any): void {
    // Capture read once: an options getter could answer otherwise next time.
    const capture = captureOf(options);
    // Each option read by name: a spread copies own properties only, and would
    // drop a `once` or `signal` the options object inherits.
    super.addEventListener(
      type,
      callback,
      typeof options === 'object' && options
        ? { capture, once: options.once, passive: options.passive, signal: options.signal }
        : capture
    );
    if (callback && isHookedType(type)) this.#listeners[type][+capture]!.add(callback);
  }

  override removeEventListener<K extends keyof EventMap>(
    type: K,
    callback: EventListenerArg<this, EventMap, K>,
    options?: boolean | EventListenerOptions
  ): void;
  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void;
  override removeEventListener(
    type: any,
    callback: any,
    options?: any
  ): void {
    const capture = captureOf(options);
    super.removeEventListener(type, callback, capture);
    if (callback && isHookedType(type)) this.#listeners[type][+capture]!.delete(callback);
  }

  private constructor() {
    super();

    this.#originalFetch = window.fetch.bind(window);
    window.fetch = this.#customFetch;
  }

  static async #dumpBody(resource: Request | Response) {
    // By instanceof, not the constructor's name: the legacy bundle minifies
    // the names of the fetch polyfill's Request and Response.
    const isRequest =
      typeof Request === 'function' && resource instanceof Request;
    const isResponse =
      typeof Response === 'function' && resource instanceof Response;
    if (!isRequest && !isResponse) return null;

    // A body that cannot be read as a blob (the fetch polyfill throws for a
    // FormData one on webOS 3) is not dumped: the dump is only for the log,
    // and its failure must not reject the request.
    let blob: Blob;
    try {
      blob = await resource.clone().blob();
    } catch {
      return null;
    }
    if (!blob.size) return null;

    // Diagnostics must not stall or reject the real request on a failed read.
    return new Promise<string | ArrayBuffer | null>((resolve) => {
      try {
        const fr = new FileReader();
        fr.addEventListener('load', () => resolve(fr.result));
        fr.addEventListener('error', () => resolve(null));
        fr.addEventListener('abort', () => resolve(null));
        fr.readAsDataURL(blob);
      } catch {
        resolve(null);
      }
    });
  }

  #customFetch = async (
    resource: FetchTarget,
    init?: RequestInit
  ): Promise<Response> => {
    // Fast path: no listeners and not debugging — pass straight through with
    // zero allocations (no URL object, no CustomEvent dispatch). Tracking
    // block off is the common case for most sessions.
    if (
      !window.__ytaf_debug__ &&
      !this.#hasListeners('request') &&
      !this.#hasListeners('response')
    ) {
      return this.#originalFetch(resource as Parameters<typeof fetch>[0], init);
    }

    if (window.__ytaf_debug__) {
      console.debug(`Request ${this.#fetchCount}:`, resource);
      init && console.debug(`Options  ${this.#fetchCount}:`, init);

      if (resource instanceof Request) {
        const reqBody = await FetchRegistry.#dumpBody(resource);
        reqBody && console.debug(`Request Body ${this.#fetchCount}:`, reqBody);
      }
    }

    let reqAllowed = true;
    if (this.#hasListeners('request')) {
      // Against the page: the fetch polyfill (webOS 3) keeps a Request's
      // relative URL as it was given.
      const url = new URL(
        resource instanceof Request ? resource.url : resource.toString(),
        document.location.href
      );

      reqAllowed = this.dispatchEvent(
        new TypedCustomEvent('request', {
          detail: { url, resource, init },
          cancelable: true
        })
      );
    }

    if (!reqAllowed) {
      console.info(
        `Fetch request ${this.#fetchCount} was cancelled by listener.`,
        resource,
        init
      );
      throw new TypeError('Failed to fetch');
    }

    const res = await this.#originalFetch(resource as Parameters<typeof fetch>[0], init);

    if (window.__ytaf_debug__) {
      console.debug(`Response ${this.#fetchCount}:`, res);

      const resBody = await FetchRegistry.#dumpBody(res);
      resBody && console.debug(`Response Body ${this.#fetchCount}:`, resBody);
    }

    let resAllowed = true;
    if (this.#hasListeners('response')) {
      resAllowed = this.dispatchEvent(
        new TypedCustomEvent('response', { detail: res, cancelable: true })
      );
    }

    if (!resAllowed) {
      console.info(
        `Fetch response ${this.#fetchCount} was cancelled by listener.`,
        res
      );
      throw new TypeError('Failed to fetch');
    }

    this.#fetchCount++;

    return res;
  };

  static getInstance() {
    if (!registry) {
      registry = new FetchRegistry();
    }
    return registry;
  }

  [Symbol.dispose]() {
    window.fetch = this.#originalFetch;
    registry = null;
  }
}