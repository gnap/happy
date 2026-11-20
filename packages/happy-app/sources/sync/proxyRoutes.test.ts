import { describe, expect, it } from 'vitest';
import { collectProxyRoutes } from './proxyRoutes';

describe('collectProxyRoutes', () => {
    it('unions what the known machines publish, without duplicates', () => {
        expect(collectProxyRoutes([
            { metadata: { proxyRoutes: ['work', 'personal'] } },
            { metadata: { proxyRoutes: ['personal', 'lab'] } },
        ])).toEqual(['lab', 'personal', 'work']);
    });

    it('keeps the profile\'s own route even when no machine publishes it', () => {
        // The machine that serves it may be offline, or simply not known to this App yet.
        expect(collectProxyRoutes([], 'personal')).toEqual(['personal']);
    });

    it('ignores machines that publish nothing and blank names', () => {
        expect(collectProxyRoutes([
            { metadata: null },
            {},
            { metadata: { proxyRoutes: ['  ', 'personal'] } },
        ])).toEqual(['personal']);
    });
});
