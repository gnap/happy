/**
 * `fetch` with a bound that actually holds.
 *
 * Why this exists: most `fetch` calls in this app had no bound at all, and the ones that looked
 * bounded were not. A `timeout` passed as an option only covers part of a request's life; what is
 * needed is something that aborts the *whole* thing, including DNS resolution and connection
 * setup, which is where a stalled server or a half-open connect actually strands you. An
 * `AbortController` does that — its signal covers every phase.
 *
 * Same class of bug as the one the CLI fixed in its own axios calls (`signal: AbortSignal.timeout`
 * alongside `timeout:`). Without it a request can outlive any stated budget indefinitely, and the
 * symptom is a sync that simply never completes rather than one that fails and retries.
 *
 * `AbortController` rather than `AbortSignal.timeout` deliberately: the latter is not guaranteed
 * to exist in the React Native runtime, and every other bounded call in this codebase already
 * uses this pattern.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
    input: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Honour a caller's own signal too, so an outer cancellation still works.
    if (init.signal) {
        if (init.signal.aborted) {
            clearTimeout(timer);
            throw new Error(`Request aborted before start: ${input}`);
        }
        init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
