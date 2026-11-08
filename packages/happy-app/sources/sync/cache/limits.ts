/**
 * The sizes the message cache is allowed to reach.
 *
 * Shared rather than written at each site: the save path, the startup migration and the hydration
 * window describe the same cache, and a cache that keeps one bound in memory and another on disk
 * is a cache that disagrees with itself.
 */

/**
 * Rows kept per session.
 *
 * The cache is a window, not the history. Opening reads sixty; paging back reaches the rest over
 * the channel that owns the log. Everything past this is retention with no reader, and it is what
 * grew the device's file to 170MB and made a save hundreds of rows of work.
 */
export const MAX_CACHED_MESSAGES = 500;

/**
 * The largest reducer state worth persisting.
 *
 * It is a projection of the newest sixty messages, so it is normally 100–250KB. Past this it is
 * holding something the trim does not take; rebuilding it from the messages is cheaper than
 * deserialising it on every open.
 */
export const MAX_REDUCER_STATE_BYTES = 256 * 1024;
