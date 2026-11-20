/**
 * What to do about a desired lifecycle that the facts do not reflect yet.
 *
 * The log states what this machine wants; `sessionStatusOf` says what it can see. This module is
 * the policy between the two, kept pure so the interesting cases — a restart that never brought a
 * process up, an archive whose process outlived the tombstone, a want that should stop being
 * retried — are decided by tests rather than by a timer callback.
 *
 * The rule that keeps this from becoming a machine that starts every session it has ever known is
 * the generation comparison. A want that was realized and later stopped still has `observed >=
 * desired`: there is no "stopped" spec, so a stopped process is not a missing want. Only a newer
 * want that no process has realized — a restart or a create whose attempt died — leaves a gap, and
 * only that gap is retried.
 */

import type { LifecycleDesiredState } from './lifecycleLog';
import type { SessionPhase } from './sessionStatus';

export type ReconcileSpec = {
    /** The folded identity: the tag when there is one, otherwise the session id. */
    key: string;
    lifecycle: LifecycleDesiredState;
    generation: number;
    at: number;
    tag?: string;
    sessionId?: string;
};

export type ReconcileObservation = {
    phase: SessionPhase;
    observedGeneration: number;
};

/**
 * What this reconciler has done about one spec generation.
 *
 * Keyed to a generation on purpose: a newer want is a different problem, and carrying the old
 * attempts into it would make a fresh request inherit a blocked verdict it never earned.
 */
export type ReconcileProgress = {
    generation: number;
    attempts: number;
    nextAttemptAt: number;
    blocked?: { reason: string; at: number };
};

export type ReconcileDecision =
    | { kind: 'settled' }
    | { kind: 'in-flight'; reason: string }
    | { kind: 'backoff'; reason: string; nextAttemptAt: number }
    | { kind: 'blocked'; reason: string; attempts: number }
    | { kind: 'resume'; reason: string; attempt: number }
    | { kind: 'archive'; reason: string; attempt: number };

/**
 * The wait before each retry, before the cap.
 *
 * A failed restart is usually a transient spawn or server problem, so the first retries are
 * close together; the tail keeps a want that cannot be realized from spawning on every tick.
 * Five attempts is the point at which the answer is "stuck", not "later".
 */
export const RECONCILE_BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000] as const;

export const MAX_RECONCILE_ATTEMPTS = RECONCILE_BACKOFF_MS.length;

/** How often an in-flight want is looked at again. Liveness/registration usually settles it. */
export const RECONCILE_IN_FLIGHT_RECHECK_MS = 5_000;

/** Progress for the same want only. A new generation starts with a clean slate. */
function forGeneration(progress: ReconcileProgress | undefined, spec: ReconcileSpec): ReconcileProgress | undefined {
    return progress?.generation === spec.generation ? progress : undefined;
}

export function decideReconcile(args: {
    spec: ReconcileSpec;
    observation: ReconcileObservation;
    progress?: ReconcileProgress;
    now: number;
}): ReconcileDecision {
    const { spec, observation, now } = args;
    const progress = forGeneration(args.progress, spec);

    if (spec.lifecycle === 'archived') {
        if (observation.phase === 'Archived') {
            return { kind: 'settled' };
        }
        // The log says the session is gone; the process (or the local row) is what has not caught
        // up. This is terminal, so it is retried until the effect matches the want.
        return retryOrBlock(progress, now, 'spec-archived', 'archive');
    }

    if (observation.phase === 'Archived') {
        // Archiving is terminal. A newer `running` want cannot undo it with the vocabulary this
        // version has, so saying so is more useful than repeatedly trying to spawn into a tombstone.
        return { kind: 'blocked', reason: 'archived-but-want-running', attempts: progress?.attempts ?? 0 };
    }

    if (
        observation.phase === 'Scheduling'
        || observation.phase === 'Starting'
        || observation.phase === 'Restarting'
    ) {
        // Something is already on its way to this want: a spawn is scheduled, a process has not
        // registered, or a restart is replacing the old one. Acting now would be a second attempt.
        return { kind: 'in-flight', reason: 'in-flight' };
    }

    if (observation.observedGeneration >= spec.generation) {
        // The want was realized at some point. A stopped process afterwards is not a missing want:
        // there is no separate "stopped" spec, and waking every idle session is not what this is for.
        return { kind: 'settled' };
    }

    if (observation.phase === 'Running') {
        // A process is registered, but at an older generation, and nothing is replacing it: a
        // restart or a spawn would have read as `Restarting`/`Scheduling` above. This is the
        // restart the previous daemon accepted and died before performing, so the old process has
        // to be stopped and a new one started in its place — a resume that stops first, never a
        // second process beside the one that is still serving.
        return retryOrBlock(progress, now, 'newer-want-while-running', 'resume');
    }

    // Stopped or Unknown, below the desired generation. This is the restart/create attempt that
    // was accepted and never converged.
    return retryOrBlock(progress, now, 'want-not-observed', 'resume');
}

function retryOrBlock(
    progress: ReconcileProgress | undefined,
    now: number,
    reason: string,
    action: 'resume' | 'archive',
): ReconcileDecision {
    if (progress?.blocked) {
        return { kind: 'blocked', reason: progress.blocked.reason, attempts: progress.attempts };
    }
    if (progress !== undefined && now < progress.nextAttemptAt) {
        return { kind: 'backoff', reason, nextAttemptAt: progress.nextAttemptAt };
    }
    const attempts = progress?.attempts ?? 0;
    if (attempts >= MAX_RECONCILE_ATTEMPTS) {
        return { kind: 'blocked', reason, attempts };
    }
    return { kind: action, reason, attempt: attempts + 1 };
}

/**
 * The next progress entry after a decision, or `undefined` once nothing is outstanding.
 *
 * The driver writes this back before it acts, so a crash or a slow spawn cannot turn into a burst
 * of attempts in the same tick.
 */
export function nextReconcileProgress(
    decision: ReconcileDecision,
    spec: ReconcileSpec,
    progress: ReconcileProgress | undefined,
    now: number,
): ReconcileProgress | undefined {
    const current = forGeneration(progress, spec);
    switch (decision.kind) {
        case 'settled':
            return undefined;
        case 'in-flight':
            // Keep the attempt count: a spawn that is still pending should not reset the retry
            // budget, or a failing machine would retry forever.
            return {
                generation: spec.generation,
                attempts: current?.attempts ?? 0,
                nextAttemptAt: now + RECONCILE_IN_FLIGHT_RECHECK_MS,
            };
        case 'backoff':
            return current ?? {
                generation: spec.generation,
                attempts: 0,
                nextAttemptAt: decision.nextAttemptAt,
            };
        case 'blocked':
            return {
                generation: spec.generation,
                attempts: decision.attempts,
                nextAttemptAt: Number.POSITIVE_INFINITY,
                blocked: { reason: decision.reason, at: now },
            };
        case 'resume':
        case 'archive':
            return {
                generation: spec.generation,
                attempts: decision.attempt,
                // The last attempt is followed by one decision that turns it into `blocked`, so
                // the transition is published instead of waiting for a timer that never fires.
                nextAttemptAt: decision.attempt >= MAX_RECONCILE_ATTEMPTS
                    ? now
                    : now + RECONCILE_BACKOFF_MS[decision.attempt - 1],
            };
    }
}
