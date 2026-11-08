import type { SessionChannel } from '@/sync/lan/types';
import { normalizeChannelPriority } from '@/sync/lan/channelOrder';

/**
 * Which channels this device has switched on.
 *
 * `channelPriority` is one array doing two jobs: the order to prefer channels in, and the set that
 * is on — omitting a channel is how it is turned off. The order half had an owner; the set half did
 * not, and was re-derived at six call sites as `priority.includes('…')`, each spelled slightly
 * differently (one through a helper, one off the store inline, three in a row in one `useMemo`).
 * Six places to change when a channel is added, and six chances for one of them to say `'lan'` where
 * it meant `'relay'` — which is the kind of mistake that shows up as a channel that is silently
 * never used.
 *
 * Normalised the same way resolution normalises it, which is not incidental: the raw list can be
 * empty or still be the pre-relay one, and the sites below used to disagree with the resolver about
 * what that meant. An empty setting means the default set, everywhere, or a device whose setting was
 * blanked has channels that are on for reading and off for connecting.
 */
export function enabledChannels(priority: readonly SessionChannel[]): Record<SessionChannel, boolean> {
    // Everything begins off, so a channel this build has never heard of cannot come back on.
    const enabled: Record<SessionChannel, boolean> = { lan: false, relay: false, server: false };
    for (const channel of normalizeChannelPriority([...priority])) {
        enabled[channel] = true;
    }
    return enabled;
}

/** Whether one channel is on. Shorthand for the many call sites that ask about exactly one. */
export function channelEnabled(priority: readonly SessionChannel[], channel: SessionChannel): boolean {
    return enabledChannels(priority)[channel];
}
