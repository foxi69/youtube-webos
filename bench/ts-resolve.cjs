/**
 * Lets a test import src/ modules that import a .ts file without its
 * extension (as webpack resolves '../custom-event-target'); Node strips the
 * types itself. Synchronous hooks where Node has them, so a require() in a
 * preload (bench/ci.sh --coverage, --late) still works.
 */
const mod = require('module');

// Node strips the types on its own from 22.18 (package.json "engines"); an
// older one could not load the .ts file the test reaches, and failed there.
if (!process.features || !process.features.typescript) {
  console.error(`Node ${process.version} cannot load .ts files without a flag: Node 22.18 or newer is needed (package.json "engines").`);
  process.exit(1);
}

const RELATIVE = /^\.\.?\//;
const HAS_EXT = /\.[cm]?[jt]s$/;

if (typeof mod.registerHooks === 'function') {
  mod.registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (e) {
        if (RELATIVE.test(specifier) && !HAS_EXT.test(specifier)) return next(specifier + '.ts', context);
        throw e;
      }
    }
  });
} else {
  mod.register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (${RELATIVE}.test(specifier) && !${HAS_EXT}.test(specifier)) return next(specifier + '.ts', context);
    throw e;
  }
}`));
}
