import { describe, expect, it } from 'vitest';
import { AsyncLock } from './lock';

describe('AsyncLock', () => {
    it('reports zero while free and the time it has been held', async () => {
        const lock = new AsyncLock();
        expect(lock.heldFor()).toBe(0);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const running = lock.inLock(async () => { await gate; });
        await Promise.resolve();

        // The clock is passed in so the test does not have to sleep.
        expect(lock.heldFor(Date.now() + 5_000)).toBeGreaterThanOrEqual(5_000);

        release();
        await running;
        expect(lock.heldFor()).toBe(0);
    });

    it('reset releases a waiter and leaves the lock free', async () => {
        const lock = new AsyncLock();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const first = lock.inLock(async () => { await gate; });
        await Promise.resolve();

        let secondRan = false;
        const second = lock.inLock(async () => { secondRan = true; });
        await Promise.resolve();
        expect(secondRan).toBe(false);

        // What a stuck-holder recovery does: whoever is queued behind the holder proceeds.
        lock.reset();
        await second;
        expect(secondRan).toBe(true);

        release();
        await first;
    });
});
