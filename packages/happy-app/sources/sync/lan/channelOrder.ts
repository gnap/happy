import type { SessionChannel } from './types';

/** The order the app used before it was configurable: a machine on the network, the server, then the emergency relay. */
export const DEFAULT_CHANNEL_PRIORITY: SessionChannel[] = ['lan', 'server', 'relay'];

/**
 * Turns a stored priority list into a usable one: unknown and repeated entries are dropped, and an
 * empty result falls back to the default. A list is the set of *enabled* channels in preference
 * order, so omitting one is how it is switched off — which is what lets a single channel be
 * isolated for debugging.
 */
export function normalizeChannelPriority(raw: unknown): SessionChannel[] {
    const valid: SessionChannel[] = [];
    if (Array.isArray(raw)) {
        for (const entry of raw) {
            if ((entry === 'lan' || entry === 'relay' || entry === 'server') && !valid.includes(entry)) {
                valid.push(entry);
            }
        }
    }
    return valid.length > 0 ? valid : [...DEFAULT_CHANNEL_PRIORITY];
}

/**
 * The first enabled channel that is reachable right now.
 *
 * When none is, the top-priority enabled channel is returned anyway rather than skipping to a
 * disabled one: with a single channel left on, "not reachable" has to surface as that channel
 * failing, not as traffic quietly going somewhere the user turned off.
 */
export function pickChannel(
    priority: SessionChannel[],
    available: Record<SessionChannel, boolean>
): { channel: SessionChannel; reachable: boolean } {
    for (const channel of priority) {
        if (available[channel]) {
            return { channel, reachable: true };
        }
    }
    return { channel: priority[0], reachable: false };
}
