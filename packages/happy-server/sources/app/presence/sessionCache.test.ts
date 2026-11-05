import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db, findUnique, updateMany } = vi.hoisted(() => {
    const findUnique = vi.fn();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    return {
        db: { session: { findUnique, updateMany } },
        findUnique,
        updateMany,
    };
});

vi.mock("@/storage/db", () => ({ db }));

import { ActivityCache } from "./sessionCache";

const SID = "session-1";
const USER = "user-1";

describe("ActivityCache session presence", () => {
    let cache: ActivityCache;

    beforeEach(async () => {
        vi.useRealTimers();
        findUnique.mockReset();
        updateMany.mockReset();
        updateMany.mockResolvedValue({ count: 1 });
        findUnique.mockResolvedValue({
            id: SID,
            accountId: USER,
            lastActiveAt: new Date(1_000),
        });
        cache = new ActivityCache();
        await cache.isSessionValid(SID, USER);
    });

    afterEach(() => {
        cache.shutdown();
        vi.useRealTimers();
    });

    it("applies the first snapshot and drops an identical repeat", async () => {
        const first = cache.applySessionSnapshot(SID, USER, {
            time: 2_000,
            thinking: false,
        });
        expect(first.accepted).toBe(true);
        expect(first.changed).toBe(true);
        expect(first.presence.active).toBe(true);

        const repeat = cache.applySessionSnapshot(SID, USER, {
            time: 2_001,
            thinking: false,
        });
        // Absolute state, not a heartbeat: the second frame carries no information.
        expect(repeat.accepted).toBe(true);
        expect(repeat.changed).toBe(false);
        expect(repeat.presence.activeAt).toBe(2_001);
    });

    it("keeps the turn's start time while thinking stays true", () => {
        cache.applySessionSnapshot(SID, USER, { time: 2_000, thinking: true, thinkingAt: 2_000 });
        const later = cache.applySessionSnapshot(SID, USER, {
            time: 3_000,
            thinking: true,
            thinkingAt: 3_000,
        });
        expect(later.changed).toBe(false);
        expect(later.presence.thinkingAt).toBe(2_000);
    });

    it("resets the start time when a turn ends and a new one begins", () => {
        cache.applySessionSnapshot(SID, USER, { time: 2_000, thinking: true, thinkingAt: 2_000 });
        cache.applySessionSnapshot(SID, USER, { time: 3_000, thinking: false });
        expect(cache.getSessionPresence(SID)?.thinkingAt).toBe(0);

        const next = cache.applySessionSnapshot(SID, USER, {
            time: 4_000,
            thinking: true,
            thinkingAt: 4_000,
        });
        expect(next.changed).toBe(true);
        expect(next.presence.thinkingAt).toBe(4_000);
    });

    it("rejects a frame from a superseded session process", () => {
        cache.applySessionSnapshot(SID, USER, { time: 2_000, thinking: false, startedAt: 2_000 });
        const stale = cache.applySessionSnapshot(SID, USER, {
            time: 3_000,
            thinking: true,
            startedAt: 1_000,
        });
        expect(stale.accepted).toBe(false);
        expect(cache.getSessionPresence(SID)?.thinking).toBe(false);
    });

    it("clears a queued alive update when the session ends", async () => {
        cache.applySessionSnapshot(SID, USER, { time: 2_000, thinking: false });
        expect((cache as unknown as { sessionCache: Map<string, { pendingUpdate: number | null }> })
            .sessionCache.get(SID)?.pendingUpdate).toBe(2_000);

        const ended = await cache.markSessionEnded(SID, USER, 5_000);
        expect(ended.changed).toBe(true);
        expect(ended.presence?.active).toBe(false);
        expect((cache as unknown as { sessionCache: Map<string, { pendingUpdate: number | null }> })
            .sessionCache.get(SID)?.pendingUpdate).toBeNull();

        updateMany.mockClear();
        await (cache as unknown as { flushPendingUpdates: () => Promise<void> }).flushPendingUpdates();
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("only deactivates after the last socket's grace, and a reconnect cancels it", async () => {
        vi.useFakeTimers();
        cache.applySessionSnapshot(SID, USER, { time: Date.now(), thinking: false });

        const generation = cache.noteConnectionOpen(USER, SID);
        const onInactive = vi.fn();
        expect(cache.isSessionLive(SID)).toBe(true);

        cache.noteConnectionClosed(USER, SID, generation, 15_000, onInactive);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(onInactive).not.toHaveBeenCalled();

        // A reconnect inside the grace invalidates the pending close.
        const reconnect = cache.noteConnectionOpen(USER, SID);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(onInactive).not.toHaveBeenCalled();
        expect(cache.isSessionLive(SID)).toBe(true);

        cache.noteConnectionClosed(USER, SID, reconnect, 15_000, onInactive);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(onInactive).toHaveBeenCalledTimes(1);
        expect(onInactive.mock.calls[0][0].active).toBe(false);
        expect(cache.isSessionLive(SID)).toBe(false);
    });

    it("does not deactivate while another socket for the session is open", async () => {
        vi.useFakeTimers();
        cache.applySessionSnapshot(SID, USER, { time: Date.now(), thinking: false });

        const first = cache.noteConnectionOpen(USER, SID);
        cache.noteConnectionOpen(USER, SID);
        const onInactive = vi.fn();

        cache.noteConnectionClosed(USER, SID, first, 15_000, onInactive);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(onInactive).not.toHaveBeenCalled();
        expect(cache.isSessionLive(SID)).toBe(true);
    });
});
