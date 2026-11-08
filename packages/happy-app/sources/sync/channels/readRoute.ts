/**
 * Which routes one read may use, in the order it may use them.
 *
 * Pure, and extracted for one reason: the pin is the rule that is easiest to lose when this is
 * changed — a session a person pinned to a channel must read on that channel and nowhere else — and
 * while it lived inside the engine there was no way to test it without a store, a socket and a
 * running daemon.
 */
import type { DaemonRoute } from '@/sync/lan/types';

export function readRoutes(args: {
    /** A route the person pinned this session to, from `channelOverride`. */
    pinned?: DaemonRoute | 'server';
    /** A route the caller demanded outright (the dev page, and internal callers). */
    forced?: DaemonRoute;
    /** What the device's priority chose for this session. */
    chosen: DaemonRoute | 'server';
    /** Whether a daemon channel would accept a read, asked in priority order. */
    accepts: (route: DaemonRoute) => boolean;
}): DaemonRoute[] {
    // A demand first, a pin second: both are someone saying so, and neither is a preference to be
    // weighed against what a channel reports.
    if (args.forced) {
        return [args.forced];
    }
    if (args.pinned) {
        return args.pinned === 'server' ? [] : [args.pinned];
    }
    if (args.chosen !== 'server') {
        // One channel, one route: a session on the relay does not browse for a machine known to be
        // elsewhere, and one on the LAN never goes through the relay.
        return [args.chosen];
    }
    // The server is carrying it, so it has no channel of its own: every daemon channel that would
    // take the read is offered, in the device's priority order.
    return (['lan', 'relay'] as const).filter((route) => args.accepts(route));
}
