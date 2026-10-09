import { describe, expect, it } from 'vitest';
import { ratesSince } from './metrics';

const counters = (over: Partial<Record<string, number>> = {}) => ({
    daemonReads: 0, entriesDecrypted: 0, messagesApplied: 0, storeWrites: 0,
    socketFrames: 0, cacheSaves: 0, cacheBytes: 0, ...over,
});

describe('ratesSince', () => {
    it('reports the delta per second', () => {
        const rates = ratesSince(counters({ storeWrites: 10 }), counters({ storeWrites: 30 }), 2_000);
        expect(rates.storeWrites).toBe(10);
    });

    it('reports zero rather than a negative rate across a reset', () => {
        // Counters restart at zero when the App reloads, and a sample spanning that is not a drop.
        expect(ratesSince(counters({ storeWrites: 500 }), counters({ storeWrites: 5 }), 1_000).storeWrites).toBe(0);
    });

    it('does not divide by a zero interval', () => {
        expect(Number.isFinite(ratesSince(counters(), counters({ cacheSaves: 1 }), 0).cacheSaves)).toBe(true);
    });
});
