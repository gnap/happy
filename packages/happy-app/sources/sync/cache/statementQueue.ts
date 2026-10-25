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
    /** When the job now in flight started, or null when the connection is free. */
    private runningSince: number | null = null;

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
                queuedAt: Date.now(),
                depth: this.waiting + 1,
            });
            void this.pump();
        });
    }

    /**
     * Called after every statement with how long it waited and how long it took.
     *
     * The two are the whole diagnosis of a slow read: waiting is this queue's business — who is
     * ahead of whom — and taking is the connection's, which is where a statement left un-finalised
     * by an earlier failure shows up as seconds rather than milliseconds.
     */
    onStatement: ((statement: { waited: number; ran: number; depth: number; beats: number }) => void) | null = null;

    /**
     * How long the job in flight has been running, or 0 when the connection is free.
     *
     * A job whose promise never resolves holds the connection for good, and everyone behind it
     * waits for nothing: measured on a device, statements waiting 51, 56 and 65 seconds with 4-5
     * queued behind them. That is what a JS context being replaced leaves behind — the work was
     * handed to a native connection whose caller is gone — so the caller asks this and starts over
     * with a queue and a connection of its own.
     */
    get stuckFor(): number {
        return this.runningSince === null ? 0 : Date.now() - this.runningSince;
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
                const waited = Date.now() - next.queuedAt;
                const ranAt = Date.now();
                this.runningSince = ranAt;
                // A heartbeat, running while the statement does: if the JS thread is free, its
                // ticker fires on schedule; if it is blocked, the ticks stop. Comparing the two
                // after the fact is what tells a slow *connection* from a slow *everything else*
                // wearing the connection's number — a statement reported as 23s that ticked the
                // whole way through was native work, one that ticked twice was waiting for the
                // thread to come back.
                let beats = 0;
                const ticker = setInterval(() => { beats += 1; }, 250);
                try {
                    next.resolve(await next.work());
                } catch (error) {
                    // A failed statement is the caller's business, not the queue's: the next job
                    // runs either way, which is what keeps one bad save from stalling the cache.
                    next.reject(error);
                } finally {
                    clearInterval(ticker);
                    this.runningSince = null;
                    this.onStatement?.({ waited, ran: Date.now() - ranAt, depth: next.depth, beats });
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
    /** When it was handed to the queue, and how many were waiting at that moment. */
    queuedAt: number;
    depth: number;
};
