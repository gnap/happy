/**
 * Counters for the work the sync engine does, so load can be read rather than guessed at.
 *
 * Deliberately just counters: they are incremented on paths that already run thousands of times a
 * minute, so an increment has to cost nothing, and a reader takes two samples and subtracts. The
 * Dev Tools page is the reader.
 */
export type MetricCounter =
    | 'daemonReads'
    | 'entriesDecrypted'
    | 'messagesApplied'
    | 'storeWrites'
    | 'socketFrames'
    | 'cacheSaves'
    | 'cacheBytes';

export const metrics: Record<MetricCounter, number> = {
    daemonReads: 0,
    entriesDecrypted: 0,
    messagesApplied: 0,
    storeWrites: 0,
    socketFrames: 0,
    cacheSaves: 0,
    cacheBytes: 0,
};

export function bump(counter: MetricCounter, by = 1): void {
    metrics[counter] += by;
}

export type MetricRates = Record<MetricCounter, number>;

/**
 * Per-second rates between two samples. Counters only ever grow, so a negative rate means the
 * numbers were read across a counter reset (a reload) rather than a real drop, and is reported as
 * zero instead of a nonsense negative.
 */
export function ratesSince(previous: Record<MetricCounter, number>, current: Record<MetricCounter, number>, elapsedMs: number): MetricRates {
    const seconds = Math.max(elapsedMs, 1) / 1000;
    const rates = {} as MetricRates;
    for (const key of Object.keys(current) as MetricCounter[]) {
        const delta = current[key] - (previous[key] ?? 0);
        rates[key] = delta > 0 ? delta / seconds : 0;
    }
    return rates;
}
