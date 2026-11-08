import { describe, expect, it, vi } from 'vitest';
import { InvalidateSync } from './sync';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('InvalidateSync', () => {
    it('runs the command once for a burst of invalidations', async () => {
        const command = vi.fn(async () => { await tick(10); });
        const sync = new InvalidateSync(command);
        sync.invalidate();
        sync.invalidate();
        sync.invalidate();
        await tick(50);
        // The second and third collapse into one follow-up run, not three.
        expect(command.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('recovers when the command never settles', async () => {
        // The shape of the reported failure: a fetch that neither resolves nor rejects — an abort
        // lost across a suspension — used to hold `_invalidated` true forever, so every later
        // invalidate (a resume, a push, a pull) did nothing at all.
        vi.useFakeTimers();
        try {
            let calls = 0;
            const sync = new InvalidateSync(async () => {
                calls += 1;
                if (calls === 1) {
                    await new Promise<void>(() => { /* never settles */ });
                }
            });

            sync.invalidate();
            await vi.advanceTimersByTimeAsync(90_000 + 1);

            sync.invalidate();
            await vi.advanceTimersByTimeAsync(10);
            expect(calls).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('resolves awaitQueue even when a run is abandoned, so a pull-to-refresh stops spinning', async () => {
        vi.useFakeTimers();
        try {
            const sync = new InvalidateSync(async () => {
                await new Promise<void>(() => { /* never settles */ });
            });
            sync.invalidate();
            let returned = false;
            void sync.awaitQueue().then(() => { returned = true; });
            await vi.advanceTimersByTimeAsync(90_000 + 1);
            expect(returned).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
