import { describe, expect, it } from 'vitest';
import { FetchSlots } from './fetchSlots';

describe('FetchSlots', () => {
    it('hands out up to the limit and then refuses', () => {
        const slots = new FetchSlots(2, 1_000);
        expect(slots.tryAcquire(0)).toBe(1);
        expect(slots.tryAcquire(0)).toBe(2);
        expect(slots.tryAcquire(0)).toBeNull();
        expect(slots.inFlight).toBe(2);
    });

    it('frees a slot on release, and ignores a release for a lease it reclaimed', () => {
        const slots = new FetchSlots(1, 1_000);
        const token = slots.tryAcquire(0)!;
        expect(slots.release(token)).toBe(true);
        expect(slots.tryAcquire(0)).toBe(2);
        // The stale holder waking up later must not free a slot it no longer owns.
        expect(slots.release(token)).toBe(false);
        expect(slots.inFlight).toBe(1);
    });

    it('reclaims a holder that never released, so the pool cannot stay empty', () => {
        // This is the reported failure: a fetch suspended mid-request never reaches its finally.
        const slots = new FetchSlots(1, 90_000);
        expect(slots.tryAcquire(0)).toBe(1);
        expect(slots.tryAcquire(89_999)).toBeNull();
        expect(slots.tryAcquire(90_000)).toBe(2);
        expect(slots.inFlight).toBe(1);
    });

    it('reclaims only the expired holders', () => {
        const slots = new FetchSlots(2, 1_000);
        const first = slots.tryAcquire(0)!;
        const second = slots.tryAcquire(500)!;
        expect(slots.tryAcquire(1_200)).not.toBeNull();
        expect(slots.release(first)).toBe(false);
        expect(slots.release(second)).toBe(true);
    });
});
