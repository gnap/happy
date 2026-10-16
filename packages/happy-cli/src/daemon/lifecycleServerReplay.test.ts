import { describe, expect, it, vi } from 'vitest';
import { replayDeletions } from './lifecycleServerReplay';
import type { LifecycleEntry } from './lifecycleLog';

const entry = (rev: number, op: 'created' | 'deleted', sessionId?: string): LifecycleEntry =>
    ({ rev, at: 0, op, tag: `tag-${rev}`, ...(sessionId ? { sessionId } : {}) });

describe('replayDeletions', () => {
    it('tells the server about the endings, and only the endings', async () => {
        // A session registers itself with the server — that path has always existed — so this
        // channel only ever has to carry what the server cannot learn on its own.
        const remove = vi.fn(async (_sessionId: string) => true);
        const advance = vi.fn();
        const at = await replayDeletions(
            [entry(1, 'created', 'a'), entry(2, 'deleted', 'a'), entry(3, 'created', 'b')],
            0,
            { remove, advance },
        );
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('a');
        expect(at).toBe(3);
    });

    it('starts where the server channel got to, not at the beginning', async () => {
        // The cursor is what decouples the channels: the LAN reader may be at the end while the
        // server is still catching up, and neither waits for the other.
        const remove = vi.fn(async (_sessionId: string) => true);
        await replayDeletions([entry(1, 'deleted', 'a'), entry(2, 'deleted', 'b')], 1, { remove, advance: () => undefined });
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('b');
    });

    it('stops at a refusal instead of advancing past it', async () => {
        // Entries are ordered; stepping over one that did not land is how a deletion is lost.
        const remove = vi.fn(async (sessionId: string) => sessionId === 'a');
        const advance = vi.fn();
        const at = await replayDeletions(
            [entry(1, 'deleted', 'a'), entry(2, 'deleted', 'b'), entry(3, 'deleted', 'c')],
            0,
            { remove, advance },
        );
        expect(remove.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
        expect(at).toBe(1);
        expect(advance).toHaveBeenCalledWith(1);
        expect(advance).not.toHaveBeenCalledWith(2);
    });

    it('resumes from where it stopped, rather than from the start', async () => {
        const entries = [entry(1, 'deleted', 'a'), entry(2, 'deleted', 'b')];
        const first = vi.fn(async (_sessionId: string) => false);
        expect(await replayDeletions(entries, 0, { remove: first, advance: () => undefined })).toBe(0);

        const second = vi.fn(async (_sessionId: string) => true);
        expect(await replayDeletions(entries, 0, { remove: second, advance: () => undefined })).toBe(2);
        expect(second.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    });

    it('is an empty walk when there is nothing new', async () => {
        const remove = vi.fn(async (_sessionId: string) => true);
        expect(await replayDeletions([entry(1, 'deleted', 'a')], 1, { remove, advance: () => undefined })).toBe(1);
        expect(remove).not.toHaveBeenCalled();
    });

    it('passes over an ending for a session the server never named', async () => {
        // Nothing to remove, and nothing to wait for: it is behind us either way.
        const remove = vi.fn(async (_sessionId: string) => true);
        expect(await replayDeletions([entry(1, 'deleted')], 0, { remove, advance: () => undefined })).toBe(1);
        expect(remove).not.toHaveBeenCalled();
    });
});
