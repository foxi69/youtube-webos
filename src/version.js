// The version the settings panel shows in its heading ("YouTube Extended
// 0.8.9"). webpack's DefinePlugin writes it at build time from package.json,
// which the release workflow sets to the version it builds; a source loaded
// without webpack shows "dev".

/* global __YTAF_VERSION__ */
/** The version of this build, as the panel heading shows it. */
export const VERSION_LABEL = typeof __YTAF_VERSION__ === 'string' ? __YTAF_VERSION__ : 'dev';
