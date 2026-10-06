import { logger } from "@/ui/logger";
import { delay } from "@/utils/time";
import { watch } from "fs/promises";

/**
 * Watching a file that does not exist yet is the normal case, not an error: Claude Code
 * creates the session jsonl when the conversation starts, which can be well after we begin
 * watching a session id restored from metadata. So a failed attempt has to be retried rather
 * than given up on.
 *
 * Retrying on a fixed one-second interval is what it used to do, which turns a session id
 * whose file never appears -- metadata pointing at a transcript that has since been deleted,
 * say -- into a per-second wake-up and a per-second log line, forever. Backing off instead
 * costs one attempt per half minute once it settles, and still attaches within a second of a
 * file that shows up promptly.
 */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Doubling delay per consecutive failure, capped. Exported so the schedule is testable. */
export function nextRetryDelayMs(consecutiveFailures: number): number {
    return Math.min(RETRY_MIN_MS * 2 ** consecutiveFailures, RETRY_MAX_MS);
}

export function startFileWatcher(file: string, onFileChange: (file: string) => void) {
    const abortController = new AbortController();

    void (async () => {
        let consecutiveFailures = 0;
        /** The delay we last reported, so the trail shows the backoff settling rather than every attempt. */
        let reportedDelayMs = 0;
        while (true) {
            try {
                if (consecutiveFailures === 0) {
                    // Only on a fresh watch. A retry reports itself below, and reporting every
                    // attempt here as well would leave the one-line-per-attempt noise in place.
                    logger.debug(`[FILE_WATCHER] Starting watcher for ${file}`);
                }
                const watcher = watch(file, { persistent: true, signal: abortController.signal });
                for await (const event of watcher) {
                    if (abortController.signal.aborted) {
                        return;
                    }
                    // The watch is working, so the next failure starts the ramp over.
                    consecutiveFailures = 0;
                    reportedDelayMs = 0;
                    logger.debug(`[FILE_WATCHER] File changed: ${file}`);
                    onFileChange(file);
                }
            } catch (e: any) {
                if (abortController.signal.aborted) {
                    return;
                }
                const retryInMs = nextRetryDelayMs(consecutiveFailures);
                consecutiveFailures += 1;
                if (retryInMs !== reportedDelayMs) {
                    logger.debug(`[FILE_WATCHER] Watch error: ${e.message}, retrying in ${retryInMs}ms`);
                    reportedDelayMs = retryInMs;
                }
                await delay(retryInMs);
            }
        }
    })();

    return () => {
        abortController.abort();
    };
}
