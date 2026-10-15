/**
 * What the channels add up to — the one answer anything above the drivers needs.
 *
 * The drivers say what each of them measures; this decides what to do with that. The split matters
 * because the two halves change for different reasons: a channel's measurement changes when its
 * transport does, and the answer here changes when this device's *preferences* do.
 */

import type { SessionChannel } from '@/sync/lan/types';
import type { ChannelDriver, ChannelOperation, SessionReach } from './types';

/**
 * How this session is being reached, from the channel that is reaching it.
 *
 * The drivers are consulted in the order this device prefers its channels, and the first one that
 * is reaching the session is the answer: a session being served over the LAN is on the LAN even
 * while the server still believes it is away, and one the server is holding is on the server when
 * nothing closer can reach it.
 *
 * A channel that reports it is *not* reaching a session does not end the search — what it means is
 * "this one is not how you are reaching it", and whether some other channel is depends on that
 * other channel. Only reports of reaching are trusted to be about the session at all.
 */
export function resolveSessionReach(
    sessionId: string,
    machineId: string | undefined,
    drivers: readonly ChannelDriver[],
    now: number = Date.now(),
): SessionReach {
    // Every channel is asked, even after one says it is reaching the session: only the first
    // reaching one decides the answer, but the most recent word about *when* may come from another
    // — the LAN reaches a session by holding the machine open, which dates nothing.
    let reaching: ChannelDriver['channel'] | null = null;
    let seenAt: number | undefined;
    for (const driver of drivers) {
        const report = driver.session(sessionId, machineId, now);
        if (!report) {
            continue;
        }
        if (report.seenAt !== undefined && (seenAt === undefined || report.seenAt > seenAt)) {
            seenAt = report.seenAt;
        }
        if (report.reaching && reaching === null) {
            reaching = driver.channel;
        }
    }
    return reaching === null
        ? { online: false, channel: null, seenAt }
        : { online: true, channel: reaching, seenAt };
}

/**
 * How long a route that failed to serve this session is left out of the running.
 *
 * Long enough that a route is not re-tried every tick, short enough that it recovers on its own —
 * a daemon may log the session later, and nothing else would ever bring the route back.
 */
export const ROUTE_FAILURE_TTL_MS = 90_000;

/** Whether a route's failure for this session is recent enough to keep it out of the running. */
export function routeFailedRecently(
    failedAt: number | undefined,
    now: number,
    ttlMs: number = ROUTE_FAILURE_TTL_MS,
): boolean {
    return failedAt !== undefined && now - failedAt < ttlMs;
}

/**
 * Which channels could serve this session right now.
 *
 * The one place this is decided, so that what the App draws and what it does cannot disagree about
 * the same session — they were computed separately, and the header would show a channel as up that
 * the resolver would not use.
 *
 * The evidence is the *device's own*, never the session's claim that it supports a channel: a
 * session declares that when it registers, which says what its daemon can do in principle, not
 * that this device can reach it. So a channel is available when this device has seen the machine
 * on it, or is holding a connection to it, or has read this very session over it. The last of those
 * is the strongest — it is the reason a working route is not dropped when a browse is missed — and
 * it is why this takes a session rather than only a machine.
 *
 * A route that has just failed to serve this session is out until that failure ages out, which is
 * what stops a broken channel being chosen again on every tick.
 */
export function channelAvailability(args: {
    drivers: readonly ChannelDriver[];
    sessionId: string;
    machineId: string;
    /** When each route last failed for this session, from the caller's own memory. */
    failedAt?: Record<string, number | undefined>;
    /** The channel this session was last read over, if it has been. */
    lastReadRoute?: SessionChannel;
    now?: number;
}): Partial<Record<SessionChannel, boolean>> {
    const now = args.now ?? Date.now();
    const available: Partial<Record<SessionChannel, boolean>> = {};
    for (const driver of args.drivers) {
        if (routeFailedRecently(args.failedAt?.[driver.channel], now)) {
            available[driver.channel] = false;
            continue;
        }
        const measured = driver.machine(args.machineId, now)?.reachable === true;
        available[driver.channel] = measured || args.lastReadRoute === driver.channel;
    }
    return available;
}

/**
 * The channels that can carry an operation at all, in this device's order of preference.
 *
 * Empty means the App cannot do this to this machine however it tries: every channel that could
 * have was switched off. That is a different thing from "it failed", and worth being able to say
 * before anything is attempted.
 */
export function channelsFor(drivers: readonly ChannelDriver[], operation: ChannelOperation): SessionChannel[] {
    return drivers.filter((driver) => driver.supports(operation)).map((driver) => driver.channel);
}

/** Whether any channel this device has switched on can carry this operation. */
export function operationSupported(drivers: readonly ChannelDriver[], operation: ChannelOperation): boolean {
    return drivers.some((driver) => driver.supports(operation));
}
