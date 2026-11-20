/**
 * The clock and the verdicts of a deletion waiting for its machine.
 *
 * A delete is a request to the machine that owns the session, and that machine can be asleep. The
 * App therefore keeps the intent (see `PendingSessionDelete`) and retries it, rather than turning
 * an unreachable owner into a server-side deletion — which would remove the row from the account
 * while the machine still held a running session. This module is the part that can be reasoned
 * about without channels: how long to wait after a failed attempt, which intents are due, and what
 * an answer from the machine means for the intent.
 *
 * Kept free of storage and sync on purpose: it is the policy, and the caller owns the effects.
 */

import type { PendingSessionDelete } from './persistence';

/**
 * The wait before the next attempt, by attempt count (1 = the first retry).
 *
 * A phone that just lost its machine should keep trying at human pace, and then stop being a
 * battery cost: five seconds, fifteen, a minute, five minutes, and then every fifteen. The ladder
 * never gives up on its own. A deletion is the person's decision; the machine being off is not a
 * reason to quietly reverse it, and the row says it is still waiting.
 */
export const DELETE_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000] as const;

export function deleteRetryDelayMs(attempts: number): number {
    const index = Math.max(0, attempts - 1);
    return DELETE_RETRY_DELAYS_MS[Math.min(index, DELETE_RETRY_DELAYS_MS.length - 1)];
}

/** When an attempt that has now failed `attempts` times may be tried again. */
export function nextDeleteAttemptAt(attempts: number, now: number): number {
    return now + deleteRetryDelayMs(attempts);
}

/** The intents that are worth an attempt now, oldest due first. */
export function dueSessionDeletes(
    intents: Readonly<Record<string, PendingSessionDelete>>,
    now: number,
): PendingSessionDelete[] {
    return Object.values(intents)
        .filter((intent) => intent.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
}

/** When the earliest waiting intent becomes due, or null when nothing is waiting. */
export function nextDeleteDueAt(
    intents: Readonly<Record<string, PendingSessionDelete>>,
): number | null {
    let next: number | null = null;
    for (const intent of Object.values(intents)) {
        if (next === null || intent.nextAttemptAt < next) {
            next = intent.nextAttemptAt;
        }
    }
    return next;
}

/** What the owning machine said about an archive attempt. */
export type ArchiveOutcome =
    | { kind: 'archived' }
    | { kind: 'refused'; status?: number; body?: string }
    /** A machine answered and has no archive route: a build older than this feature. */
    | { kind: 'unsupported' }
    /** No machine channel could carry the request right now. */
    | { kind: 'unavailable' };

/** What to do with the intent after an attempt. */
export type SessionDeleteDecision =
    /** The machine recorded it. Stop asking; the deletion is a fact. */
    | { kind: 'archived' }
    /** A build from before the route: the server's delete is the road this request used to take. */
    | { kind: 'legacy-server' }
    /** The machine answered and declined. Asking again would be the same request. */
    | { kind: 'refused'; message: string }
    /** The machine was not reachable. Keep the intent and come back. */
    | { kind: 'retry'; attempts: number; nextAttemptAt: number; lastError: string };

/**
 * Reads one archive answer as a decision about the durable intent.
 *
 * `attempts` is how many attempts had been made *before* this one, so a retry advances the ladder.
 * Only silence is retried. A refusal is the machine's answer about this account or this session,
 * and a route this build does not have is a reason to use the old road once, not to ask forever.
 */
export function decideSessionDelete(
    outcome: ArchiveOutcome,
    attempts: number,
    now: number,
): SessionDeleteDecision {
    if (outcome.kind === 'archived') {
        return { kind: 'archived' };
    }
    if (outcome.kind === 'unsupported') {
        return { kind: 'legacy-server' };
    }
    if (outcome.kind === 'refused') {
        return {
            kind: 'refused',
            message: outcome.body || 'The machine refused to delete this session',
        };
    }
    const nextAttempts = attempts + 1;
    return {
        kind: 'retry',
        attempts: nextAttempts,
        nextAttemptAt: nextDeleteAttemptAt(nextAttempts, now),
        lastError: 'The machine is not reachable',
    };
}
