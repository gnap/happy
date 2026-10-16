/**
 * One statement at a time on a connection that can only hold one — and the statement a person is
 * waiting for first.
 *
 * expo-sqlite hands out a single connection, and one connection cannot have two statements in
 * flight: overlapping them fails however the engine notices first, which here was "cannot start a
 * transaction within a transaction" and then `database is locked` with the statement un-finalised —
 * a cache that saves nothing at all. So everything runs through this.
 *
 * Waiting in arrival order is the part that turned out to be wrong. The saves are the slow half —
 * hundreds of rows, a third of a second each, one per session — and on a cold start a burst of them
 * queues up behind the very read the user's tap is waiting for: measured on a device, the row read
 * that opens a session took 2.7 s while a *larger* row took 29 ms once the burst had passed. So a
 * job that says it is urgent goes ahead of the background ones, and the interactive read waits
 * behind at most the statement already running.
 */
export class StatementQueue {
    private readonly background: Job[] = [];
    private readonly urgent: Job[] = [];
    /** True while a job is in flight — the invariant this exists to keep. */
    private running = false;

    /**
     * Runs `work` when the connection is free.
     *
     * `urgent` is for work someone is waiting on: it is taken before anything queued behind it that
     * is not. Urgent work still waits for the statement already in flight, because it has to — there
     * is one connection.
     */
    run<T>(work: () => Promise<T>, urgent = false): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            (urgent ? this.urgent : this.background).push({
                work: work as () => Promise<unknown>,
                resolve: resolve as (value: unknown) => void,
                reject,
            });
            void this.pump();
        });
    }

    /** How many jobs are waiting, for the tests and for the log line the metrics use. */
    get waiting(): number {
        return this.urgent.length + this.background.length;
    }

    private async pump(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        try {
            for (;;) {
                const next = this.urgent.shift() ?? this.background.shift();
                if (!next) {
                    return;
                }
                try {
                    next.resolve(await next.work());
                } catch (error) {
                    // A failed statement is the caller's business, not the queue's: the next job
                    // runs either way, which is what keeps one bad save from stalling the cache.
                    next.reject(error);
                }
            }
        } finally {
            this.running = false;
        }
    }
}

type Job = {
    work: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
};
