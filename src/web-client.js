/**
 * The WEB client the lookups that the TV client's own responses cannot answer
 * ask as: the AI label (youtube-ai-label.js) and the Most Replayed graph
 * (heatmap-data.js), both from the web watch page, /youtubei/v1/next. One
 * place for the version, which YouTube may stop taking one day.
 *
 * YouTube answers a client version it no longer takes with HTTP 400 to every
 * request. Several 400s in a row, and no answer in between, say so once
 * (ui.js shows it), instead of the features going quiet with nothing said.
 * No imports: the bench tests load the lookups in Node, without a page.
 */
export const WEB_CLIENT_VERSION = '2.20250601.01.00';

/** The body of a `next` request for `videoId`, in English (the AI label is read by its English text). */
export function webNextBody(videoId) {
  return JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: WEB_CLIENT_VERSION, hl: 'en' } },
    videoId
  });
}

// Six in a row: two lookups run at a time, so a short bad patch is not it.
const REFUSALS_TO_SAY = 6;
let refusals = 0;
let said = false;
let onRefused = null;

/** Sets what runs, once, when YouTube refuses the version. */
export function onWebClientRefused(fn) {
  onRefused = fn;
}

/** The HTTP status of a web lookup that got an answer (not a network error or a timeout). */
export function noteWebAnswer(status) {
  if (status !== 400) {
    refusals = 0;
    return;
  }
  if (++refusals < REFUSALS_TO_SAY || said) return;
  said = true;
  console.warn('[WebClient] YouTube refuses the web client version ' + WEB_CLIENT_VERSION);
  if (onRefused) onRefused();
}
