/**
 * Which session gets read, and when.
 *
 * There used to be one two-second timer per session: whenever the server could not serve a read,
 * the fallback started polling that session, and it was never obvious which of the timers were
 * still wanted. On a device with the server down that became six to ten sessions invalidated every
 * two seconds — a fetch storm that held the JS thread and the cache queue, and made the one
 * session the user was opening the slowest of them all.
 *
 * The rule this replaces it with is narrow: a session is read when something says its data
 * changed (a push, an explicit open, a route that can now serve it), and the *fallback poll*
 * exists once for the session on screen, not once per session. Everything else waits until it is
 * opened.
 *
 * This is deliberately not a connection manager. Transports (server socket, relay hub, daemon
 * sockets) keep owning their own links; they feed this with "this session may have changed" or
 * "the route changed", and reading is scheduled here. A transport going up or down is not itself a
 * reason to read every conversation.
 */

type SchedulerDeps = {
    /** Ask for one read of a session. The caller coalesces overlapping reads (InvalidateSync). */
    read: (sessionId: string) => void;
    /**
     * Whether the visible session has no push channel right now and needs the two-second poll.
     * Called on each tick, so it may change with the connection state.
     */
    shouldPoll: (sessionId: string) => boolean;
    intervalMs: number;
    log: (message: string) => void;
};

export class SessionReadScheduler {
    /** The session on screen, or null. At most one read is polled. */
    private visible: string | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    /** Sessions asked for in this tick; a Set so repeated pushes coalesce into one read. */
    private queued = new Set<string>();
    private pumpScheduled = false;

    constructor(private readonly deps: SchedulerDeps) {}

    /** The screen changed. The new session is read now; the timer follows the screen. */
    setVisible(sessionId: string | null): void {
        if (this.visible === sessionId) {
            if (sessionId) {
                this.wake(sessionId, 'visible');
            }
            return;
        }
        this.visible = sessionId;
        this.syncTimer();
        if (sessionId) {
            this.wake(sessionId, 'visible');
        }
    }

    /** Something says this session may have changed: a push, an open, a route that now serves it. */
    wake(sessionId: string, reason: string): void {
        this.queued.add(sessionId);
        if (this.pumpScheduled) {
            return;
        }
        this.pumpScheduled = true;
        queueMicrotask(() => {
            this.pumpScheduled = false;
            const ids = [...this.queued];
            this.queued.clear();
            for (const id of ids) {
                this.deps.read(id);
            }
        });
        this.deps.log(`📅 read scheduled: ${sessionId} (${reason})`);
    }

    /**
     * A channel changed under the app — a socket dropped or a route was re-ranked.
     *
     * Only the session on screen is read now: it is the one whose state a person is watching, and
     * whose reads would otherwise freeze until the next push. Hidden sessions are re-read when
     * they are opened, which is the only time their freshness matters.
     */
    markStale(): void {
        if (this.visible) {
            this.wake(this.visible, 'channel changed');
        }
    }

    /** Whether a fallback poll is running, for diagnostics. */
    get pollingVisible(): boolean {
        return this.timer !== null;
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.visible = null;
        this.queued.clear();
    }

    /** One timer, and only while a session is on screen. */
    private syncTimer(): void {
        if (this.visible === null) {
            if (this.timer !== null) {
                clearInterval(this.timer);
                this.timer = null;
            }
            return;
        }
        if (this.timer !== null) {
            return;
        }
        this.timer = setInterval(() => {
            if (this.visible === null) {
                return;
            }
            if (this.deps.shouldPoll(this.visible)) {
                this.wake(this.visible, 'poll');
            }
        }, this.deps.intervalMs);
        (this.timer as unknown as { unref?: () => void }).unref?.();
        this.deps.log(`📅 polling only the visible session every ${this.deps.intervalMs / 1000}s`);
    }
}
