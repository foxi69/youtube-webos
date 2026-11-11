/**
 * Lets a test import src/ modules that import a .ts file without its
 * extension (as webpack resolves '../custom-event-target'); Node strips the
 * types itself. Synchronous hooks where Node has them, so a require() in a
 * preload (bench/ci.sh --coverage, --late) still works.
 */
const mod = require('module');

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
