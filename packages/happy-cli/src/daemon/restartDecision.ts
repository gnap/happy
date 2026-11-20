/**
 * Whether a restart request is a new act or a repeat of one already done.
 *
 * A restart is expensive and destructive — it terminates the process it is replacing — so a
 * request that arrives twice must not be performed twice. The caller cannot know whether its
 * first answer was lost on a channel that then reconnected; from its side the second ask is the
 * same ask, and it is the machine's job to tell the difference.
 *
 * Two keys are used, in this order:
 *
 * 1. **Generation.** The caller sends the generation it observed. If the machine has moved past
 *    it, the restart it wants is the one that already happened. If the machine is behind it, the
 *    caller knows about a spec this machine does not — refusing is the only honest answer.
 * 2. **Time window.** A caller that sends no generation — every build before this one — is
 *    answered from the same window as before, so an unchanged caller sees unchanged semantics.
 *
 * Kept pure so the precedence is testable without a daemon: the ordering is the whole contract,
 * and it is not obvious from the outside.
 */

import { RESTART_REPEAT_WINDOW_MS } from './restartTracker';

export type RestartDecision =
    /** The request is new and should be performed. */
    | { kind: 'proceed'; generation: number }
    /** The caller is ahead of this machine; nothing was done. */
    | { kind: 'refuse-ahead'; currentGeneration: number }
    /** A restart is in flight; the request is the same one. */
    | { kind: 'in-flight'; generation: number }
    /** The restart this request asked for already happened. */
    | { kind: 'already-applied'; generation: number }
    /** A generation-less repeat inside the window of a finished restart. */
    | { kind: 'already-restarted'; generation: number };

export function restartDecision(input: {
    /** The generation the caller observed, when it sent one. */
    expectGeneration?: number;
    /** The id's generation as this machine's records know it. */
    currentGeneration: number;
    /** A restart of this id is being performed right now. */
    inFlight: boolean;
    /** When the last successful restart finished, if one did. */
    finishedAt?: number;
    now: number;
    repeatWindowMs?: number;
}): RestartDecision {
    const window = input.repeatWindowMs ?? RESTART_REPEAT_WINDOW_MS;
    const current = input.currentGeneration;

    if (input.expectGeneration !== undefined && input.expectGeneration > current) {
        return { kind: 'refuse-ahead', currentGeneration: current };
    }

    // In flight beats "already applied": the generation was bumped when the work started, so a
    // caller holding the pre-bump number would otherwise be told a restart finished while it is
    // still replacing the process.
    if (input.inFlight) {
        return { kind: 'in-flight', generation: current };
    }

    if (input.expectGeneration !== undefined && input.expectGeneration < current) {
        return { kind: 'already-applied', generation: current };
    }

    if (input.finishedAt !== undefined && input.now - input.finishedAt < window) {
        return { kind: 'already-restarted', generation: current };
    }

    return { kind: 'proceed', generation: current + 1 };
}
