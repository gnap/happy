import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiEphemeralActivityUpdate } from '../apiTypes';
import { ActivityUpdateAccumulator } from './activityUpdateAccumulator';

const update = (over: Partial<ApiEphemeralActivityUpdate> = {}): ApiEphemeralActivityUpdate => ({
    type: 'activity',
    id: 'session1',
    active: true,
    activeAt: 1000,
    thinking: false,
    thinkingAt: 0,
    ...over,
});

const nextTick = () => Promise.resolve().then(() => undefined);

describe('ActivityUpdateAccumulator', () => {
    let flush: ReturnType<typeof vi.fn>;
    let accumulator: ActivityUpdateAccumulator;

    beforeEach(() => {
        flush = vi.fn();
        accumulator = new ActivityUpdateAccumulator(flush);
    });

    it('applies the first state and a real change', async () => {
        accumulator.addUpdate(update());
        await nextTick();
        expect(flush).toHaveBeenCalledTimes(1);

        accumulator.addUpdate(update({ thinking: true, thinkingAt: 1000 }));
        await nextTick();
        expect(flush).toHaveBeenCalledTimes(2);
        expect(flush.mock.calls[1][0].get('session1')).toMatchObject({ thinking: true, thinkingAt: 1000 });
    });

    it('drops an unchanged heartbeat entirely', async () => {
        accumulator.addUpdate(update());
        await nextTick();

        accumulator.addUpdate(update({ activeAt: 2000 }));
        await nextTick();

        // This is the migration's point: a repeated absolute state is not news, even when the
        // old CLI still sends it every two seconds.
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it('applies a turn-start change even when the other fields are the same', async () => {
        accumulator.addUpdate(update({ thinking: true, thinkingAt: 1000 }));
        await nextTick();
        accumulator.addUpdate(update({ thinking: true, thinkingAt: 3000 }));
        await nextTick();

        expect(flush).toHaveBeenCalledTimes(2);
        expect(flush.mock.calls[1][0].get('session1')?.thinkingAt).toBe(3000);
    });

    it('batches different sessions that arrive in the same tick', async () => {
        accumulator.addUpdate(update({ id: 'a' }));
        accumulator.addUpdate(update({ id: 'b', thinking: true, thinkingAt: 1000 }));
        await nextTick();

        expect(flush).toHaveBeenCalledTimes(1);
        expect([...flush.mock.calls[0][0].keys()].sort()).toEqual(['a', 'b']);
    });

    it('cancel drops a pending batch, and reset forgets the last state', async () => {
        accumulator.addUpdate(update());
        accumulator.cancel();
        await nextTick();
        expect(flush).not.toHaveBeenCalled();

        // The batch was dropped before it was emitted, so the state was not recorded either.
        accumulator.addUpdate(update());
        await nextTick();
        expect(flush).toHaveBeenCalledTimes(1);

        accumulator.reset();
        accumulator.addUpdate(update());
        await nextTick();
        expect(flush).toHaveBeenCalledTimes(2);
    });

    it('flush applies a pending batch immediately', () => {
        accumulator.addUpdate(update());
        accumulator.flush();
        expect(flush).toHaveBeenCalledTimes(1);
    });
});
