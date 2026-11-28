// DeArrow's titles: the crowdsourced one when it is trusted, else YouTube's
// own, either formatted as Title Formatting says by the extension's own
// formatter (formatter.js; the legacy build has Title Case alone,
// formatter-legacy.js).
import { configRead } from '../config.js';
import { formatTitleInternal, TitleFormatting, formattingSupported } from './formatter.js';
import { deArrowOn } from './state.js';

/** Whether titles can be formatted here. */
export const titleFormattingSupported = formattingSupported;

const FORMATTING = {
  disable: TitleFormatting.Disable,
  title_case: TitleFormatting.TitleCase,
  sentence_case: TitleFormatting.SentenceCase,
  lower_case: TitleFormatting.LowerCase,
  first_letter_uppercase: TitleFormatting.FirstLetterUppercase,
  capitalize_words: TitleFormatting.CapitalizeWords
};

/** The Title Formatting choices this build's formatter has (all of them, or Disabled and Title Case). */
export function titleFormatChoices(all) {
  const out = {};
  for (const key of Object.keys(all)) {
    if (FORMATTING[key] !== undefined) out[key] = all[key];
  }
  return out;
}

/**
 * A submission DeArrow would show: not the original, and locked or voted
 * zero or above.
 */
export function isTrusted(entry) {
  return !!entry && !entry.original && (entry.locked || entry.votes >= 0);
}

/**
 * `title` formatted as Title Formatting says, the same for a crowdsourced one
 * (`isCustom`, whose ">" markers keep a word as written) as for YouTube's;
 * resolves with the text.
 */
function formatTitle(title, isCustom) {
  const supported = titleFormattingSupported;
  const formatting = supported ? FORMATTING[configRead('dearrowTitleFormatting')] : undefined;
  return formatTitleInternal(
    title,
    isCustom,
    formatting === undefined ? TitleFormatting.Disable : formatting,
    supported && !!configRead('dearrowCleanEmojis')
  );
}

/**
 * Casual Mode: casual voters said YouTube's own title is fine (funny,
 * creative, clever, descriptive or other: any of them, by at least one vote),
 * for the title the video has now. A vote names the title it was cast for;
 * one for an earlier title does not count. As DeArrow's own Casual mode with
 * its default settings (videoBranding.ts shouldShowCasualOnVideo).
 */
export function casualKeepsOriginal(video) {
  const votes = video.raw && Array.isArray(video.raw.casualVotes) ? video.raw.casualVotes : null;
  if (!votes || !votes.length) return false;
  const own = untranslatedOrOriginal(video);
  const original = typeof own === 'string' ? own.trim().toLowerCase() : '';
  return votes.some((vote) => !!vote && Number(vote.count) >= 1 &&
    (!vote.title || (typeof vote.title === 'string' && vote.title.trim().toLowerCase() === original)));
}

/** The crowdsourced title the settings let a video show: the top one when it is trusted, else null. */
export function crowdsourcedTitle(video) {
  if (!deArrowOn() || !configRead('dearrowCrowdTitles')) return null;
  if (configRead('dearrowCasualMode') && casualKeepsOriginal(video)) return null;
  const custom = video.raw && Array.isArray(video.raw.titles) ? video.raw.titles[0] : null;
  return isTrusted(custom) && typeof custom.title === 'string' ? custom : null;
}

/**
 * Whether the title as uploaded can change what a video shows: not when a
 * trusted crowdsourced title wins anyway, unless Casual Mode has votes to
 * compare with it.
 */
export function uploadedTitleMatters(video) {
  if (!deArrowOn() || !configRead('dearrowCrowdTitles')) return true;
  const raw = video.raw;
  const custom = raw && Array.isArray(raw.titles) ? raw.titles[0] : null;
  if (!isTrusted(custom) || typeof custom.title !== 'string') return true;
  return !!configRead('dearrowCasualMode') && Array.isArray(raw.casualVotes) && raw.casualVotes.length > 0;
}

/**
 * The title a video's tiles should show, or null for YouTube's own: the top
 * crowdsourced one when it is trusted, else the original when formatting
 * changes it.
 */
export async function resolveTitle(video) {
  // Show Original Titles with DeArrow off: the title as uploaded, exactly.
  if (!deArrowOn()) {
    const own = configRead('dearrowUntranslatedTitles') ? video.untranslated : null;
    return own && own !== video.original ? own : null;
  }
  const custom = crowdsourcedTitle(video);
  if (custom) return (await formatTitle(custom.title, true)) || null;

  // Show Original Titles: the title as uploaded, where YouTube shows a translation.
  const untranslated = configRead('dearrowUntranslatedTitles') ? video.untranslated : null;
  if (untranslated) return (await formatTitle(untranslated, false)) || untranslated;

  if (!video.original) return null;
  const formatted = await formatTitle(video.original, false);
  return formatted && formatted !== video.original ? formatted : null;
}

/** YouTube's own title of a video: as uploaded when Show Original Titles knows it, else as shown. */
function untranslatedOrOriginal(video) {
  return (configRead('dearrowUntranslatedTitles') && video.untranslated) || video.original;
}
