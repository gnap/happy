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
 * is the strongest — it is the reason a working route is not dropped when a browse is missed.
 */
export function channelAvailability(args: {
    drivers: readonly ChannelDriver[];
    machineId: string;
    now?: number;
}): Partial<Record<SessionChannel, boolean>> {
    const now = args.now ?? Date.now();
    const available: Partial<Record<SessionChannel, boolean>> = {};
    for (const driver of args.drivers) {
        available[driver.channel] = driver.machine(args.machineId, now)?.reachable === true;
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
