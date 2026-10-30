// What DeArrow knows, shared by its modules: the videos seen, and the
// generation that a settings change or a wipe bumps so that work started
// before it does not write stale output.

/**
 * videoId -> {
 *   original, originalThumb, duration   what YouTube sent: for formatting,
 *                                       random frames and putting it back
 *   raw                                 the branding answer (null: none)
 *   fetched, fetching                   whether it was answered / the request
 *   queued                              waiting in the lookup queue
 *   title, thumb                        what to show (null: YouTube's own)
 *   crowdTitle, crowdThumb              whether those are crowdsourced (the badge)
 *   resolved                            title and thumbnail decided
 *   shownTitle, shownThumb              what the tiles were last given
 *   tiles                               its tiles in the stored responses (tiles.js)
 * }
 */
export const videos = new Map();

/**
 * Whether a video shows something the community submitted: what the badge
 * marks. Only that, not every change: with the Random frame fallback nearly
 * every thumbnail changes, and a badge on every tile tells nothing.
 */
export const showsCrowdsourced = (video) =>
  !!((video.title && video.crowdTitle) || (video.thumb && video.crowdThumb));

// The generation: bumped by a settings change and by a wipe.
let generation = 0;

/** The current generation. */
export const currentGeneration = () => generation;

/** Starts a new generation: work begun before it drops its output. */
export function nextGeneration() {
  generation++;
}
