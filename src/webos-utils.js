export let simulatorMode = false;
let cachedWebOSVersion = undefined;

const WEBOS_YEAR_MAP = {
  2016: 3,
  2017: 3,
  2018: 4,
  2019: 4,
  2020: 5,
  2021: 6,
  2022: 22,
  2023: 23,
  2024: 24,
  2025: 25
};

export function getWebOSVersion() {
  if (cachedWebOSVersion !== undefined) {
    return cachedWebOSVersion;
  }

  const ua = window.navigator.userAgent;

  // 1. Check Platform Year
  const platformMatch = ua.match(/webOS\.TV-(\d{4})/);
  if (platformMatch) {
    const year = parseInt(platformMatch[1], 10);
    // Since 2022 the webOS version is the platform year (webOS 22, 23, ...),
    // so 2026 and later TVs need no table entry - without this they fell
    // through to the Chrome check and were treated as a simulator.
    const version = WEBOS_YEAR_MAP[year] || (year > 2025 ? year - 2000 : undefined);
    if (version) {
      cachedWebOSVersion = version;
      console.info(`[WebOSUtils] Detected webOS ${cachedWebOSVersion} via platform year: ${year}`);
      return cachedWebOSVersion;
    }
  }

  // 2. Check Firmware Version (Fallback for webOS 25+)
  const firmwareMatch = ua.match(/_TV_O18\/(\d+\.\d+\.\d+)/);
  if (firmwareMatch) {
    const majorVersion = parseInt(firmwareMatch[1].split('.')[0], 10);
    if (majorVersion >= 33) {
      cachedWebOSVersion = 25;
      console.info(`[WebOSUtils] Detected webOS 25 via firmware version: ${firmwareMatch[1]}`);
      return cachedWebOSVersion;
    }
  }

  // 3. Fallback: Chrome version detection (for simulator environments)
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  if (chromeMatch) {
    const chromeVersion = parseInt(chromeMatch[1], 10);
    simulatorMode = true;

    if (chromeVersion >= 120) {
      cachedWebOSVersion = 25;
    } else if (chromeVersion <= 53) { // webOS 4
      cachedWebOSVersion = 4;
    } else {
      cachedWebOSVersion = 6;
    }
    console.info(`[WebOSUtils] Detected webOS ${cachedWebOSVersion} via Chrome version: ${chromeVersion} (simulator mode)`);
    return cachedWebOSVersion;
  }

  console.warn('[WebOSUtils] Could not detect webOS version from user agent. Defaulting to 6.');
  return cachedWebOSVersion = 6;
}

export function isWebOS25() {
  return getWebOSVersion() >= 25;
}

export function isLegacyWebOS() {
  const version = getWebOSVersion();
  return version >= 3 && version <= 6;
}

// A bridge collected before its answer arrives drops the answer: each call
// stays referenced until it is done.
const liveBridges = [];

/**
 * Calls a luna service. `onResponse(res)` gets each answer as an object (an
 * answer that is null or not JSON comes as {}); the call is dropped after the
 * first one unless `keep(res)` says more are coming. Returns the bridge
 * (cancel() ends a subscription), or null when there is no service bridge.
 */
export function lunaCall(uri, params, onResponse, keep) {
  const Bridge = typeof window !== 'undefined' ? window.PalmServiceBridge : null;
  if (typeof Bridge !== 'function') return null;
  let bridge = null;
  const release = () => {
    const i = liveBridges.indexOf(bridge);
    if (i !== -1) liveBridges.splice(i, 1);
  };
  try {
    // Serialized first: params that cannot be serialized make no bridge.
    const payload = JSON.stringify(params);
    bridge = new Bridge();
    liveBridges.push(bridge);
    // A cancelled call gets no more answers: let go of it too. A bridge
    // that will not take the wrapper keeps its own cancel.
    try {
      const cancel = bridge.cancel;
      bridge.cancel = function () {
        release();
        if (typeof cancel === 'function') return cancel.apply(this, arguments);
      };
    } catch { /* not writable */ }
    bridge.onservicecallback = (msg) => {
      let res = null;
      try { res = JSON.parse(msg); } catch { /* not JSON */ }
      if (!res || typeof res !== 'object') res = {};
      if (!keep || !keep(res)) release();
      if (onResponse) onResponse(res);
    };
    bridge.call(uri, payload);
    return bridge;
  } catch {
    // A call that threw gets no answer: its bridge is not kept either.
    release();
    return null;
  }
}
