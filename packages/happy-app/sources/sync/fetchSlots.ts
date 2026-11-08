/**
 * A pool of fetch slots whose holders expire.
 *
 * The pool exists to keep a reconnect from firing a hundred requests at once, so its size is a
 * limit on *concurrency*, not a queue that may be filled forever. What it cannot assume is that a
 * holder ever releases: a fetch suspended mid-request on iOS may never see its abort, and its
 * `finally` then never runs. Five of those used to leave the pool empty for the life of the
 * process, and every later fetch — for any session — waited on a promise nothing would resolve.
 *
 * So a holder is a lease. Past its lifetime the slot is reclaimable, and the stale holder's own
 * release becomes a no-op rather than a double-free.
 */
export class FetchSlots {
    private held = new Map<number, number>();
    private nextToken = 1;

    constructor(
        private readonly max: number,
        private readonly leaseMs: number,
    ) {}

    /** A token when there is room, else null. Reclaims expired leases first. */
    tryAcquire(now: number): number | null {
        this.reclaim(now);
        if (this.held.size >= this.max) {
            return null;
        }
        const token = this.nextToken++;
        this.held.set(token, now);
        return token;
    }

    /** False when the lease had already been reclaimed, which the caller must not treat as a free slot. */
    release(token: number): boolean {
        return this.held.delete(token);
    }

    /** Drops a lease that never released, without touching anyone else's. */
    private reclaim(now: number): void {
        for (const [token, startedAt] of this.held) {
            if (now - startedAt >= this.leaseMs) {
                this.held.delete(token);
            }
        }
    }

    get inFlight(): number {
        return this.held.size;
    }

    /** Longest a current holder has been running, for the load counters. */
    oldestHeldFor(now: number): number {
        let oldest = 0;
        for (const startedAt of this.held.values()) {
            oldest = Math.max(oldest, now - startedAt);
        }
        return oldest;
    }

    /** Everything in flight is void — used when a suspension means no holder can be trusted. */
    reset(): void {
        this.held.clear();
    }
}
