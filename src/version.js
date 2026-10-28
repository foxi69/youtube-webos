// The version the settings panel shows in its heading ("YouTube Extended
// 0.9.1 (a1b2c3d)"). webpack's DefinePlugin writes it at build time from
// package.json, which the release workflow sets to the version it builds,
// and the commit the workflow builds (YTAF_BUILD; none in a local build); a
// source loaded without webpack shows "dev".

/* global __YTAF_VERSION__ */
/** The version of this build, as the panel heading shows it. */
export const VERSION_LABEL = typeof __YTAF_VERSION__ === 'string' ? __YTAF_VERSION__ : 'dev';
