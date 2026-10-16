import { describe, expect, it, vi } from 'vitest';
import { replayToServer } from './lifecycleServerReplay';
import type { LifecycleEntry, LifecycleReachableEntry } from './lifecycleLog';

const entry = (rev: number, op: 'created' | 'deleted', sessionId?: string): LifecycleEntry =>
    ({ rev, at: 0, op, tag: `tag-${rev}`, ...(sessionId ? { sessionId } : {}) });

const reachable = (rev: number, addr = '192.168.1.5'): LifecycleReachableEntry =>
    ({ rev, at: 100 + rev, op: 'reachable', endpoints: [{ t: 'lan', addr, port: 55673 }] });

/** For the walks that are about deletions: an address has nothing to say here. */
const noReachable = { publishReachable: async () => true };

describe('replayToServer', () => {
    it('tells the server about the endings, and only the endings', async () => {
        // A session registers itself with the server — that path has always existed — so this
        // channel only ever has to carry what the server cannot learn on its own.
        const remove = vi.fn(async (_sessionId: string) => true);
        const advance = vi.fn();
        const at = await replayToServer(
            [entry(1, 'created', 'a'), entry(2, 'deleted', 'a'), entry(3, 'created', 'b')],
            0,
            { remove, advance, ...noReachable },
        );
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('a');
        expect(at).toBe(3);
    });

    it('starts where the server channel got to, not at the beginning', async () => {
        // The cursor is what decouples the channels: the LAN reader may be at the end while the
        // server is still catching up, and neither waits for the other.
        const remove = vi.fn(async (_sessionId: string) => true);
        await replayToServer([entry(1, 'deleted', 'a'), entry(2, 'deleted', 'b')], 1, { remove, advance: () => undefined, ...noReachable });
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('b');
    });

    it('stops at a refusal instead of advancing past it', async () => {
        // Entries are ordered; stepping over one that did not land is how a deletion is lost.
        const remove = vi.fn(async (sessionId: string) => sessionId === 'a');
        const advance = vi.fn();
        const at = await replayToServer(
            [entry(1, 'deleted', 'a'), entry(2, 'deleted', 'b'), entry(3, 'deleted', 'c')],
            0,
            { remove, advance, ...noReachable },
        );
        expect(remove.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
        expect(at).toBe(1);
        expect(advance).toHaveBeenCalledWith(1);
        expect(advance).not.toHaveBeenCalledWith(2);
    });

    it('resumes from where it stopped, rather than from the start', async () => {
        const entries = [entry(1, 'deleted', 'a'), entry(2, 'deleted', 'b')];
        const first = vi.fn(async (_sessionId: string) => false);
        expect(await replayToServer(entries, 0, { remove: first, advance: () => undefined, ...noReachable })).toBe(0);

        const second = vi.fn(async (_sessionId: string) => true);
        expect(await replayToServer(entries, 0, { remove: second, advance: () => undefined, ...noReachable })).toBe(2);
        expect(second.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    });

    it('is an empty walk when there is nothing new', async () => {
        const remove = vi.fn(async (_sessionId: string) => true);
        expect(await replayToServer([entry(1, 'deleted', 'a')], 1, { remove, advance: () => undefined, ...noReachable })).toBe(1);
        expect(remove).not.toHaveBeenCalled();
    });

    it('passes over an ending for a session the server never named', async () => {
        // Nothing to remove, and nothing to wait for: it is behind us either way.
        const remove = vi.fn(async (_sessionId: string) => true);
        expect(await replayToServer([entry(1, 'deleted')], 0, { remove, advance: () => undefined, ...noReachable })).toBe(1);
        expect(remove).not.toHaveBeenCalled();
    });

    it('writes where the machine can be reached, because the server is one of the readers', async () => {
        // The server is a channel like any other: the address arrives here replayed rather than
        // pushed inline, so a machine whose server connection is down is not a machine whose address
        // the server never learns.
        const publishReachable = vi.fn(async (_e: unknown, _at: number) => true);
        const advance = vi.fn();
        const at = await replayToServer(
            [entry(1, 'created', 'a'), reachable(2), reachable(3, '192.168.1.99')],
            0,
            { remove: async () => true, publishReachable, advance },
        );
        expect(publishReachable.mock.calls.map(([endpoints]) => (endpoints as { addr: string }[])[0].addr))
            .toEqual(['192.168.1.5', '192.168.1.99']);
        expect(at).toBe(3);
        expect(advance).toHaveBeenLastCalledWith(3);
    });

    it('leaves the cursor before an address that did not land, so the newer one is not applied early', async () => {
        // Applying the later entry while the earlier one is still owed would be the same address
        // written in the wrong order — and the older one would then overwrite the newer.
        const publishReachable = vi.fn(async (_e: unknown, _at: number) => false);
        const at = await replayToServer(
            [reachable(1), reachable(2, '192.168.1.99')],
            0,
            { remove: async () => true, publishReachable, advance: () => undefined },
        );
        expect(publishReachable).toHaveBeenCalledTimes(1);
        expect(at).toBe(0);
    });
});
