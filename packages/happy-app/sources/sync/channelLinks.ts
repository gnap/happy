import type { SessionChannel } from './lan/types';
import { normalizeChannelPriority } from './lan/channelOrder';

/** How a channel is doing, as the header shows it: one icon per channel, coloured by this. */
export type ChannelLinkState = 'connected' | 'connecting' | 'disconnected';

/** What the header needs to know about each channel's link, from this device's own state. */
export type ChannelFacts = {
    serverStatus: string;
    /** A connection to some machine over this network is up. */
    lanSocket: boolean;
    /** Some machine is advertising on this network. */
    lanSeen: boolean;
    /** The App's one connection to the relay is up. */
    relayConnected: boolean;
};

/**
 * One entry per enabled channel, highest priority first, and how that channel is doing.
 *
 * Pure, and takes the facts explicitly, because this is the App's summary of its own channels: the
 * decisions in it — which channels appear at all, and what "down" means for each — are worth
 * stating in one place and testing rather than reading off a live store.
 *
 * The priority is normalised the same way the rest of the App normalises it. Reading the stored
 * value raw meant a device whose setting had been blanked to an empty list showed *no* channel
 * icons at all — a header that says nothing, which reads as "this App has no channels".
 */
export function channelLinks(
    priority: readonly SessionChannel[],
    facts: ChannelFacts
): { channel: SessionChannel; state: ChannelLinkState }[] {
    const links: { channel: SessionChannel; state: ChannelLinkState }[] = [];
    for (const channel of normalizeChannelPriority([...priority])) {
        if (channel === 'server') {
            links.push({
                channel,
                state: facts.serverStatus === 'connected' ? 'connected' : facts.serverStatus === 'connecting' ? 'connecting' : 'disconnected',
            });
        } else if (channel === 'lan') {
            // Hidden until this device has seen a machine on this network: an icon for a network
            // nothing has been seen on would claim a channel that has never had anything to talk to.
            if (facts.lanSocket) links.push({ channel, state: 'connected' });
            else if (facts.lanSeen) links.push({ channel, state: 'connecting' });
        } else {
            // The relay channel is its one connection to the relay, not the per-machine streams it
            // carries: whether a stream exists depends on whether a session is being read right
            // now, which is not a property of the channel. Connected means the relay is reachable;
            // while it is switched on and not yet reached, the App is trying, which is the blue.
            links.push({ channel, state: facts.relayConnected ? 'connected' : 'connecting' });
        }
    }
    return links;
}
