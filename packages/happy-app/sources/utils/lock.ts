export class AsyncLock {
    private permits: number = 1;
    private promiseResolverQueue: Array<(v: boolean) => void> = [];
    /** When the current holder acquired the lock, or null while it is free. */
    private heldSince: number | null = null;

    async inLock<T>(func: () => Promise<T> | T): Promise<T> {
        try {
            await this.lock();
            return await func();
        } finally {
            this.unlock();
        }
    }

    /**
     * How long the current holder has been in the lock.
     *
     * A holder that never settles — a request the OS cancelled without rejecting, the shape a
     * suspended fetch leaves behind — blocks every later reader of that session with no way to
     * tell "slow" from "gone". The caller can use this to reset the lock instead of waiting for a
     * `finally` that will never run.
     */
    heldFor(now: number = Date.now()): number {
        return this.heldSince === null ? 0 : now - this.heldSince;
    }

    private async lock() {
        if (this.permits > 0) {
            this.permits = this.permits - 1;
            this.heldSince = Date.now();
            return;
        }
        await new Promise<boolean>(resolve => this.promiseResolverQueue.push(resolve));
        this.heldSince = Date.now();
    }

    /**
     * Release the lock regardless of who holds it, for callers that know better than the lock does:
     * after iOS has suspended the App, a holder cannot be assumed to still be running, and every
     * waiter queued behind it would otherwise wait for a `finally` that never comes. A holder that
     * does finish later unlocks a lock it no longer owns — which is why `unlock` tolerates a permit
     * count above one rather than throwing.
     */
    reset(): void {
        this.permits = 1;
        this.heldSince = null;
        const waiting = this.promiseResolverQueue;
        this.promiseResolverQueue = [];
        for (const resolve of waiting) {
            resolve(true);
        }
    }

    private unlock() {
        // The holder is leaving. Whether the permit is handed on or the lock becomes free, the
        // next holder's `lock()` stamps the new time; a lock with nobody in it reports zero.
        this.heldSince = null;
        this.permits += 1;
        if (this.permits > 1 && this.promiseResolverQueue.length > 0) {
            // Only reachable after a reset: the permit belongs to whoever the reset released it to.
            this.permits -= 1;
            const nextResolver = this.promiseResolverQueue.shift();
            if (nextResolver) {
                setTimeout(() => nextResolver(true), 0);
            }
            return;
        } else if (this.permits === 1 && this.promiseResolverQueue.length > 0) {
            // If there is someone else waiting, immediately consume the permit that was released
            // at the beginning of this function and let the waiting function resume.
            this.permits -= 1;

            const nextResolver = this.promiseResolverQueue.shift();
            // Resolve on the next tick
            if (nextResolver) {
                setTimeout(() => {
                    nextResolver(true);
                }, 0);
            }
        }
    }
}