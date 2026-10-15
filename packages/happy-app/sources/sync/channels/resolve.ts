/**
 * What the channels add up to — the one answer anything above the drivers needs.
 *
 * The drivers say what each of them measures; this decides what to do with that. The split matters
 * because the two halves change for different reasons: a channel's measurement changes when its
 * transport does, and the answer here changes when this device's *preferences* do.
 */

import type { ChannelDriver, SessionReach } from './types';

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
 * Which channels could carry this machine right now.
 *
 * The shape `pickChannel` takes, and deliberately not an answer of its own: choosing between
 * channels is one policy with one implementation (`channelOrder.pickChannel`), and a second
 * "which channel for this machine" that answered *null* where that one answers "the first by
 * priority, unreachable" would be a second policy wearing the same name.
 */
export function machineAvailability(
    machineId: string,
    drivers: readonly ChannelDriver[],
    now: number = Date.now(),
): Record<string, boolean> {
    const available: Record<string, boolean> = {};
    for (const driver of drivers) {
        available[driver.channel] = driver.machine(machineId, now)?.reachable === true;
    }
    return available;
}
