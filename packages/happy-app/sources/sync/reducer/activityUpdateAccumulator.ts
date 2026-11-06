import type { ApiEphemeralActivityUpdate } from '../apiTypes';

/**
 * Passes through only state that actually changed, and batches a burst in the same tick.
 *
 * The server now emits an activity frame on a transition rather than every two seconds, but the
 * old fleet still repeats itself and a duplicate can also arrive across reconnects. State here is
 * absolute, so equality is the whole idempotence rule: active, thinking and the turn's start time.
 * There is deliberately no timer — an idle App must not wake to re-apply an unchanged heartbeat.
 */
export class ActivityUpdateAccumulator {
    private pendingUpdates = new Map<string, ApiEphemeralActivityUpdate>();
    private lastEmittedStates = new Map<string, { active: boolean; thinking: boolean; thinkingAt: number }>();
    private flushScheduled = false;

    constructor(
        private flushHandler: (updates: Map<string, ApiEphemeralActivityUpdate>) => void,
        /** Kept for call-site compatibility; there is nothing left to debounce. */
        _debounceDelay?: number,
    ) {}

    addUpdate(update: ApiEphemeralActivityUpdate): void {
        const lastState = this.lastEmittedStates.get(update.id);
        const thinkingAt = update.thinkingAt ?? 0;
        if (lastState
            && lastState.active === update.active
            && lastState.thinking === update.thinking
            && lastState.thinkingAt === thinkingAt) {
            return;
        }

        this.pendingUpdates.set(update.id, update);
        if (!this.flushScheduled) {
            this.flushScheduled = true;
            // A microtask, not a timer: frames that arrive in the same tick are applied together,
            // and nothing is scheduled when nothing arrived.
            void Promise.resolve().then(() => {
                this.flushScheduled = false;
                this.flushPendingUpdates();
            });
        }
    }

    private flushPendingUpdates(): void {
        if (this.pendingUpdates.size === 0) {
            return;
        }
        const updatesToFlush = new Map(this.pendingUpdates);
        this.pendingUpdates.clear();
        this.flushHandler(updatesToFlush);
        for (const [sessionId, update] of updatesToFlush) {
            this.lastEmittedStates.set(sessionId, {
                active: update.active,
                thinking: update.thinking,
                thinkingAt: update.thinkingAt ?? 0,
            });
        }
    }

    cancel(): void {
        this.pendingUpdates.clear();
    }

    reset(): void {
        this.cancel();
        this.lastEmittedStates.clear();
    }

    flush(): void {
        this.flushPendingUpdates();
    }
}
