export class AsyncLock {
    private permits: number = 1;
    private promiseResolverQueue: Array<(v: boolean) => void> = [];

    async inLock<T>(func: () => Promise<T> | T): Promise<T> {
        try {
            await this.lock();
            return await func();
        } finally {
            this.unlock();
        }
    }

    private async lock() {
        if (this.permits > 0) {
            this.permits = this.permits - 1;
            return;
        }
        await new Promise<boolean>(resolve => this.promiseResolverQueue.push(resolve));
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
        const waiting = this.promiseResolverQueue;
        this.promiseResolverQueue = [];
        for (const resolve of waiting) {
            resolve(true);
        }
    }

    private unlock() {
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