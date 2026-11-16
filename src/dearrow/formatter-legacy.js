// What the legacy build (webOS 3 to 6) has in place of formatter.js
// (webpack.config.js): DeArrow's Title Case from a port of its formatter that
// needs no \p{...} regular expressions (src/vendor/bolli, from Bolli YouTube),
// so it runs on Chrome 38 too, at about a quarter of the size. It gives the
// same text as formatter.js for Title Case; the other formats, language
// detection and Turkish and Greek casing are in formatter.js only.
import { toTitleCase, cleanEmojis, cleanFancyText, unmark } from '../vendor/bolli/title-format.ts';

/** Whether titles can be formatted: Title Case, in this build. */
export const formattingSupported = true;

/** The formatter's modes, as formatter.js names them: the ones this build has. */
export const TitleFormatting = { Disable: -1, TitleCase: 1 };

/**
 * As formatter.js's: `title` with emojis and fancy letters taken out when
 * asked, then in Title Case, or as written with the ">" markers taken out.
 */
export function formatTitleInternal(title, isCustom, titleFormatting, shouldCleanEmojis) {
  if (shouldCleanEmojis) title = cleanFancyText(cleanEmojis(title));
  return Promise.resolve(titleFormatting === TitleFormatting.TitleCase
    ? toTitleCase(title, isCustom)
    : unmark(title).trim());
}
