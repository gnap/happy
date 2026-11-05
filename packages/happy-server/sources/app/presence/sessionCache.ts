import { db } from "@/storage/db";
import { log } from "@/utils/log";
import {
    sessionCacheCounter,
    databaseUpdatesSkippedCounter,
    sessionPresenceEventsCounter,
    sessionPresenceDbWritesCounter,
} from "@/app/monitoring/metrics2";

interface SessionCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
}

interface MachineCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
}

/**
 * What a session has said about itself, not what the database last heard.
 *
 * The socket connection is the liveness fact; this is the state that rides on it. A session is
 * alive while its session-scoped socket is open (plus a short reconnect grace), not because a
 * heartbeat keeps rewriting a timestamp. `thinking` lives here rather than in the database: it
 * changes on turns, it is in-memory by nature, and the list endpoints merge it in.
 */
export interface SessionPresence {
    userId: string;
    active: boolean;
    thinking: boolean;
    thinkingAt: number;
    /** Monotonic: a replayed or out-of-order frame cannot move "last seen" backwards. */
    activeAt: number;
    /** Client process start time; a frame from an older process must not override a newer one. */
    startedAt: number;
    endedAt: number;
}

/** One session-scoped socket owner's connection count, and the grace token for its last close. */
interface SessionConnection {
    userId: string;
    count: number;
    generation: number;
    timer: NodeJS.Timeout | null;
}

export class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    private presence = new Map<string, SessionPresence>();
    private connections = new Map<string, SessionConnection>();
    private batchTimer: NodeJS.Timeout | null = null;

    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;

    // Only update DB if time difference is significant (30 seconds)
    private readonly UPDATE_THRESHOLD = 30 * 1000;

    // Batch update interval (5 seconds)
    private readonly BATCH_INTERVAL = 5 * 1000;

    // Presence that has been inactive with nobody connected this long is safe to forget.
    private readonly PRESENCE_IDLE_TTL = 60 * 60 * 1000;

    constructor() {
        this.startBatchTimer();
    }

    private startBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
        }

        this.batchTimer = setInterval(() => {
            this.flushPendingUpdates().catch(error => {
                log({ module: 'session-cache', level: 'error' }, `Error flushing updates: ${error}`);
            });
        }, this.BATCH_INTERVAL);
    }

    async isSessionValid(sessionId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.sessionCache.get(sessionId);

        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'session_validation', result: 'hit' });
            return true;
        }

        sessionCacheCounter.inc({ operation: 'session_validation', result: 'miss' });

        // Cache miss - check database
        try {
            const session = await db.session.findUnique({
                where: { id: sessionId, accountId: userId }
            });

            if (session) {
                // Cache the result
                this.sessionCache.set(sessionId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: session.lastActiveAt.getTime(),
                    pendingUpdate: null,
                    userId
                });
                return true;
            }

            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating session ${sessionId}: ${error}`);
            return false;
        }
    }

    async isMachineValid(machineId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.machineCache.get(machineId);

        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'machine_validation', result: 'hit' });
            return true;
        }

        sessionCacheCounter.inc({ operation: 'machine_validation', result: 'miss' });

        // Cache miss - check database
        try {
            const machine = await db.machine.findUnique({
                where: {
                    accountId_id: {
                        accountId: userId,
                        id: machineId
                    }
                }
            });

            if (machine) {
                // Cache the result
                this.machineCache.set(machineId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: machine.lastActiveAt?.getTime() || 0,
                    pendingUpdate: null,
                    userId
                });
                return true;
            }

            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating machine ${machineId}: ${error}`);
            return false;
        }
    }

    /**
     * Applies a state snapshot from the session's own process.
     *
     * Idempotent: the absolute state, not an increment. A frame that does not change `active`,
     * `thinking` or `thinkingAt` is accepted and dropped — no broadcast, and no database write
     * unless the timestamp has moved far enough to be worth a checkpoint. This is what turns the
     * old 2s fleet's repetitions into silence while it is still deployed.
     */
    applySessionSnapshot(
        sessionId: string,
        userId: string,
        snapshot: { time: number; thinking: boolean; thinkingAt?: number; startedAt?: number },
    ): { accepted: boolean; changed: boolean; presence: SessionPresence } {
        const now = Date.now();
        const existing = this.presence.get(sessionId);
        if (existing && existing.userId !== userId) {
            sessionPresenceEventsCounter.inc({ result: 'rejected' });
            return { accepted: false, changed: false, presence: existing };
        }

        // A restarted session process is newer; a frame still trickling from the old one is not.
        const startedAt = Math.max(existing?.startedAt ?? 0, snapshot.startedAt ?? 0);
        if (existing && existing.startedAt > 0 && snapshot.startedAt !== undefined
            && snapshot.startedAt < existing.startedAt) {
            sessionPresenceEventsCounter.inc({ result: 'rejected' });
            return { accepted: false, changed: false, presence: existing };
        }

        const at = Math.min(typeof snapshot.time === 'number' ? snapshot.time : now, now);
        let thinking = existing?.thinking ?? false;
        let thinkingAt = existing?.thinkingAt ?? 0;
        if (snapshot.thinking !== thinking) {
            thinking = snapshot.thinking;
            thinkingAt = thinking ? (typeof snapshot.thinkingAt === 'number' ? snapshot.thinkingAt : at) : 0;
        } else if (thinking && thinkingAt === 0 && typeof snapshot.thinkingAt === 'number') {
            thinkingAt = snapshot.thinkingAt;
        }

        const next: SessionPresence = {
            userId,
            active: true,
            thinking,
            thinkingAt,
            activeAt: Math.max(existing?.activeAt ?? 0, at),
            startedAt,
            endedAt: 0,
        };
        this.presence.set(sessionId, next);

        const changed = !existing
            || !existing.active
            || existing.thinking !== next.thinking
            || existing.thinkingAt !== next.thinkingAt;
        sessionPresenceEventsCounter.inc({ result: changed ? 'applied' : 'deduped' });

        // A transition, or a long enough gap to be a useful checkpoint. Never a periodic touch.
        this.queueSessionUpdate(sessionId, at, changed);
        return { accepted: true, changed, presence: next };
    }

    /**
     * The session is over: a clean end, a lost socket after its grace, or the timeout backstop.
     *
     * Clears the queued alive update first — the old handler wrote `active=false` directly while
     * a queued flush could still write `active=true` five seconds later.
     */
    async markSessionEnded(
        sessionId: string,
        userId: string,
        time: number,
    ): Promise<{ changed: boolean; presence: SessionPresence | null }> {
        const existing = this.presence.get(sessionId);
        if (existing && existing.userId !== userId) {
            sessionPresenceEventsCounter.inc({ result: 'rejected' });
            return { changed: false, presence: existing };
        }

        const at = Math.max(existing?.activeAt ?? 0, time);
        const next: SessionPresence = {
            userId,
            active: false,
            thinking: false,
            thinkingAt: 0,
            activeAt: at,
            startedAt: existing?.startedAt ?? 0,
            endedAt: at,
        };
        this.presence.set(sessionId, next);

        const changed = !existing
            || existing.active
            || existing.thinking
            || existing.thinkingAt !== 0;
        sessionPresenceEventsCounter.inc({ result: changed ? 'applied' : 'deduped' });

        const cached = this.sessionCache.get(sessionId);
        if (cached) {
            cached.pendingUpdate = null;
            cached.lastUpdateSent = at;
        }

        try {
            await db.session.updateMany({
                where: { id: sessionId, accountId: userId },
                data: { active: false, lastActiveAt: new Date(at) },
            });
            sessionPresenceDbWritesCounter.inc();
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error ending session ${sessionId}: ${error}`);
        }

        return { changed, presence: next };
    }

    /** A session-scoped socket opened. Returns the token its close must present. */
    noteConnectionOpen(userId: string, sessionId: string): number {
        const key = `${userId}:${sessionId}`;
        const entry = this.connections.get(key) ?? { userId, count: 0, generation: 0, timer: null };
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        entry.count += 1;
        entry.generation += 1;
        this.connections.set(key, entry);
        return entry.generation;
    }

    /**
     * A session-scoped socket closed. Only the last one starts the grace timer, and only if no
     * newer connection has opened since — a brief reconnect must not paint the session offline.
     */
    noteConnectionClosed(
        userId: string,
        sessionId: string,
        generation: number,
        graceMs: number,
        onInactive: (presence: SessionPresence) => void,
    ): void {
        const key = `${userId}:${sessionId}`;
        const entry = this.connections.get(key);
        if (!entry || entry.generation !== generation || entry.count === 0) {
            return;
        }
        entry.count -= 1;
        if (entry.count > 0) {
            return;
        }
        if (entry.timer) {
            clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
            entry.timer = null;
            if (entry.count !== 0 || entry.generation !== generation) {
                return;
            }
            const presence = this.presence.get(sessionId);
            if (!presence || presence.userId !== userId || !presence.active) {
                return;
            }
            void this.markSessionEnded(sessionId, userId, Date.now()).then(result => {
                if (result.changed && result.presence) {
                    onInactive(result.presence);
                }
            });
        }, graceMs);
        entry.timer.unref?.();
    }

    /** The liveness question the timeout sweep must not answer from a stale timestamp. */
    isSessionLive(sessionId: string): boolean {
        const presence = this.presence.get(sessionId);
        if (!presence?.active) {
            return false;
        }
        return (this.connections.get(`${presence.userId}:${sessionId}`)?.count ?? 0) > 0;
    }

    getSessionPresence(sessionId: string): SessionPresence | null {
        return this.presence.get(sessionId) ?? null;
    }

    queueSessionUpdate(sessionId: string, timestamp: number, force: boolean = false): boolean {
        const cached = this.sessionCache.get(sessionId);
        if (!cached) {
            return false; // Should validate first
        }

        // Only forward-moving checkpoints are useful; an older replay must not regress it.
        const timeDiff = timestamp - cached.lastUpdateSent;
        if (force || timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }

        databaseUpdatesSkippedCounter.inc({ type: 'session' });
        return false; // No update needed
    }

    queueMachineUpdate(machineId: string, timestamp: number): boolean {
        const cached = this.machineCache.get(machineId);
        if (!cached) {
            return false; // Should validate first
        }

        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }

        databaseUpdatesSkippedCounter.inc({ type: 'machine' });
        return false; // No update needed
    }

    private async flushPendingUpdates(): Promise<void> {
        const sessionUpdates: { id: string, timestamp: number }[] = [];
        const machineUpdates: { id: string, timestamp: number, userId: string }[] = [];

        // Collect session updates
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.pendingUpdate) {
                sessionUpdates.push({ id: sessionId, timestamp: entry.pendingUpdate });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }

        // Collect machine updates
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.pendingUpdate) {
                machineUpdates.push({
                    id: machineId,
                    timestamp: entry.pendingUpdate,
                    userId: entry.userId
                });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }

        // Batch update sessions. The `lastActiveAt < ts` guard means an older in-flight write
        // cannot undo a newer end.
        if (sessionUpdates.length > 0) {
            try {
                const results = await Promise.all(sessionUpdates.map(update =>
                    db.session.updateMany({
                        where: { id: update.id, lastActiveAt: { lt: new Date(update.timestamp) } },
                        data: { lastActiveAt: new Date(update.timestamp), active: true }
                    })
                ));
                const written = results.reduce((sum, result) => sum + result.count, 0);
                sessionPresenceDbWritesCounter.inc(written);

                log({ module: 'session-cache' }, `Flushed ${sessionUpdates.length} session updates`);
            } catch (error) {
                log({ module: 'session-cache', level: 'error' }, `Error updating sessions: ${error}`);
            }
        }

        // Batch update machines
        if (machineUpdates.length > 0) {
            try {
                await Promise.all(machineUpdates.map(update =>
                    db.machine.update({
                        where: {
                            accountId_id: {
                                accountId: update.userId,
                                id: update.id
                            }
                        },
                        data: { lastActiveAt: new Date(update.timestamp) }
                    })
                ));

                log({ module: 'session-cache' }, `Flushed ${machineUpdates.length} machine updates`);
            } catch (error) {
                log({ module: 'session-cache', level: 'error' }, `Error updating machines: ${error}`);
            }
        }
    }

    // Cleanup old cache entries periodically
    cleanup(): void {
        const now = Date.now();

        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.validUntil < now) {
                this.sessionCache.delete(sessionId);
            }
        }

        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.validUntil < now) {
                this.machineCache.delete(machineId);
            }
        }

        for (const [sessionId, presence] of this.presence.entries()) {
            const connections = this.connections.get(`${presence.userId}:${sessionId}`);
            if (!presence.active && (connections?.count ?? 0) === 0 && now - presence.activeAt > this.PRESENCE_IDLE_TTL) {
                this.presence.delete(sessionId);
                if (connections && !connections.timer) {
                    this.connections.delete(`${presence.userId}:${sessionId}`);
                }
            }
        }
    }

    shutdown(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }

        // Flush any remaining updates
        this.flushPendingUpdates().catch(error => {
            log({ module: 'session-cache', level: 'error' }, `Error flushing final updates: ${error}`);
        });
    }
}

// Global instance
export const activityCache = new ActivityCache();

// Cleanup every 5 minutes
setInterval(() => {
    activityCache.cleanup();
}, 5 * 60 * 1000);
