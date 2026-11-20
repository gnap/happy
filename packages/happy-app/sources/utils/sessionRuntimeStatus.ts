/**
 * What the App can draw from a machine's runtime statement about one session.
 *
 * The machine publishes a phase and, while its log wants something the facts do not reflect yet,
 * a `divergence`. Most of the time there is a divergence and it is simply "(nothing has caught up
 * yet" — a restart or an archive that is on its way. The interesting case is the one the machine
 * marks `blocked`: it has stopped retrying, so the row is not still working, it is stuck, and that
 * is the difference between "wait a moment" and "this needs you".
 *
 * This module decides that difference and nothing else — no colours, no words. The row and the
 * details page both read the result, so they cannot disagree about which of the two a session is.
 */

import type { SessionRuntimeEntry } from '@/sync/daemonSessionList';

export type SessionRuntimeDisplay = {
    /** `applying` is progress; `blocked` is a want that stopped being retried. */
    kind: 'applying' | 'blocked';
    /**
     * The lifecycle the machine is trying to reach.
     *
     * `other` when a newer machine named one this build has not heard of: the want is still worth
     * drawing, but the sentence has to be a general one rather than "start" or "archive".
     */
    desired: 'running' | 'archived' | 'other';
    /** The phase the statement carried, for the details page. */
    phase?: string;
};

/**
 * How long an unfinished statement is drawn after the machine last said it.
 *
 * A want in progress is restated by every complete listing, which the App asks for once a minute,
 * so three intervals of silence mean the daemon stopped answering rather than that the work is
 * still going. A blocked verdict has no such expiry: it is the machine's last word on the matter,
 * and silence must not turn "stuck" back into "fine".
 */
export const RUNTIME_APPLYING_TTL_MS = 3 * 60_000;

function desiredOf(divergence: NonNullable<SessionRuntimeEntry['divergence']>): SessionRuntimeDisplay['desired'] {
    return divergence.desired === 'running' || divergence.desired === 'archived'
        ? divergence.desired
        : 'other';
}

export function sessionRuntimeDisplay(
    entry: SessionRuntimeEntry | undefined,
    now: number = Date.now(),
): SessionRuntimeDisplay | undefined {
    if (entry === undefined || entry.divergence === undefined) {
        return undefined;
    }
    const display: SessionRuntimeDisplay = {
        kind: entry.divergence.blocked === true ? 'blocked' : 'applying',
        desired: desiredOf(entry.divergence),
        ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
    };
    if (display.kind === 'applying' && now - entry.at >= RUNTIME_APPLYING_TTL_MS) {
        // The last listing that carried this want is too old to still call progress. Falling
        // through lets the ordinary status (offline, last seen) describe what the App can see.
        return undefined;
    }
    return display;
}
