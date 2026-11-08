import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionReadScheduler } from './sessionReadScheduler';

describe('SessionReadScheduler', () => {
    let reads: string[];
    let pollable: boolean;

    const make = () => new SessionReadScheduler({
        read: (sessionId) => { reads.push(sessionId); },
        shouldPoll: () => pollable,
        isActive: () => true,
        intervalMs: 2_000,
        log: () => {},
    });

    const flush = () => vi.advanceTimersByTimeAsync(0);

    beforeEach(() => {
        vi.useFakeTimers();
        reads = [];
        pollable = true;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reads the session that was opened, once', async () => {
        const scheduler = make();

        scheduler.setVisible('a');
        scheduler.wake('a', 'push');
        scheduler.wake('a', 'push again');
        await flush();

        expect(reads).toEqual(['a']);
    });

    it('polls only the visible session, and only while it has no push channel', async () => {
        const scheduler = make();
        scheduler.setVisible('a');
        await flush();
        reads.length = 0;

        pollable = true;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(reads).toEqual(['a']);

        // A live push channel means the poll has nothing to add.
        pollable = false;
        reads.length = 0;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reads).toEqual([]);
    });

    it('stops the poll when the screen goes away', async () => {
        const scheduler = make();
        scheduler.setVisible('a');
        await flush();
        reads.length = 0;

        scheduler.setVisible(null);
        await vi.advanceTimersByTimeAsync(10_000);

        expect(reads).toEqual([]);
        expect(scheduler.pollingVisible).toBe(false);
    });

    it('stops itself when a reload supersedes its owner', async () => {
        let active = true;
        const scheduler = new SessionReadScheduler({
            read: (sessionId) => { reads.push(sessionId); },
            shouldPoll: () => true,
            isActive: () => active,
            intervalMs: 2_000,
            log: () => {},
        });
        scheduler.setVisible('a');
        await flush();
        reads.length = 0;

        active = false;
        await vi.advanceTimersByTimeAsync(4_000);

        expect(reads).toEqual([]);
        expect(scheduler.pollingVisible).toBe(false);
    });

    it('a channel change re-reads the visible session, not hidden ones', async () => {
        const scheduler = make();
        scheduler.setVisible('a');
        await flush();
        reads.length = 0;

        scheduler.markStale();
        await flush();

        expect(reads).toEqual(['a']);
    });
});
