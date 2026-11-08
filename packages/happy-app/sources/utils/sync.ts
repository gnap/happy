import { backoff } from "@/utils/time";

export class InvalidateSync {
    /**
     * How long one run may stay in flight before this sync stops counting it.
     *
     * `backoff` retries a *rejecting* command forever, which is fine. A command that never settles
     * is not: `_invalidated` stays true for good, and `invalidate()` is a no-op while it is — so
     * every later trigger (a resume, a socket reconnect, a push hint, a pull-to-refresh, the poll
     * timer) is swallowed in silence, and `awaitQueue` never returns. On a phone that is one
     * session that stops refreshing with nothing left to retry it, which is what a device looks
     * like after coming back from the background: the timers are all still armed, and all of them
     * are no-ops.
     *
     * Well past every timeout on the path it drives (a LAN read is capped at 45s), so a run that
     * reaches this has stopped making progress rather than merely being slow.
     */
    private static readonly RUN_TIMEOUT_MS = 90_000;

    private _invalidated = false;
    private _invalidatedDouble = false;
    private _stopped = false;
    private _command: () => Promise<void>;
    private _pendings: (() => void)[] = [];

    constructor(command: () => Promise<void>) {
        this._command = command;
    }

    invalidate() {
        if (this._stopped) {
            return;
        }
        if (!this._invalidated) {
            this._invalidated = true;
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            if (!this._invalidatedDouble) {
                this._invalidatedDouble = true;
            }
        }
    }

    async invalidateAndAwait() {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
            this.invalidate();
        });
    }

    async awaitQueue() {
        if (this._stopped || (!this._invalidated && this._pendings.length === 0)) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
        });
    }

    stop() {
        if (this._stopped) {
            return;
        }
        this._notifyPendings();
        this._stopped = true;
    }

    private _notifyPendings = () => {
        for (let pending of this._pendings) {
            pending();
        }
        this._pendings = [];
    }


    private _doSync = async () => {
        const run = backoff(async () => {
            if (this._stopped) {
                return;
            }
            await this._command();
        });
        // The run is abandoned rather than cancelled — nothing here can cancel it — and the sync
        // goes back to idle so the next invalidate starts a fresh one. A run that does eventually
        // finish is simply one whose result nobody is waiting for any more.
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timedOut = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), InvalidateSync.RUN_TIMEOUT_MS);
            (timer as unknown as { unref?: () => void }).unref?.();
        });
        const outcome = await Promise.race([run.then(() => 'done' as const), timedOut]);
        if (timer !== null) {
            clearTimeout(timer);
        }
        if (outcome === 'timeout') {
            console.warn(`[InvalidateSync] command still running after ${InvalidateSync.RUN_TIMEOUT_MS}ms; starting fresh on the next invalidate`);
        }
        if (this._stopped) {
            this._notifyPendings();
            return;
        }
        if (this._invalidatedDouble) {
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            this._invalidated = false;
            this._notifyPendings();
        }
    }
}

export class ValueSync<T> {
    private _latestValue: T | undefined;
    private _hasValue = false;
    private _processing = false;
    private _stopped = false;
    private _command: (value: T) => Promise<void>;
    private _pendings: (() => void)[] = [];

    constructor(command: (value: T) => Promise<void>) {
        this._command = command;
    }

    setValue(value: T) {
        if (this._stopped) {
            return;
        }
        this._latestValue = value;
        this._hasValue = true;
        if (!this._processing) {
            this._processing = true;
            this._doSync();
        }
    }

    async setValueAndAwait(value: T) {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
            this.setValue(value);
        });
    }

    async awaitQueue() {
        if (this._stopped || (!this._processing && this._pendings.length === 0)) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
        });
    }

    stop() {
        if (this._stopped) {
            return;
        }
        this._notifyPendings();
        this._stopped = true;
    }

    private _notifyPendings = () => {
        for (let pending of this._pendings) {
            pending();
        }
        this._pendings = [];
    }

    private _doSync = async () => {
        while (this._hasValue && !this._stopped) {
            const value = this._latestValue!;
            this._hasValue = false;
            
            await backoff(async () => {
                if (this._stopped) {
                    return;
                }
                await this._command(value);
            });
            
            if (this._stopped) {
                this._notifyPendings();
                return;
            }
        }
        
        this._processing = false;
        this._notifyPendings();
    }
}