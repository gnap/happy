import type { ChannelDriver, ChannelLinkState } from './channels/types';
import type { SessionChannel } from './lan/types';

/** One channel's icon, and how it is coloured. */
export type ChannelLink = { channel: SessionChannel; state: ChannelLinkState };

/**
 * One entry per channel that has something to say about itself, highest priority first, and how each
 * is doing.
 *
 * Pure, and takes the drivers rather than the raw facts, because what it draws *is* the drivers'
 * own answers: each channel knows whether it is connected, whether it is still trying, and whether
 * it has any business being drawn at all — an icon for a network nothing has been seen on claims a
 * channel that has never had anything to talk to. Re-deriving those from store fields here is how
 * the header came to show a channel as reachable that the resolver would not use, and the other way
 * round.
 *
 * The priority and the enabled set are applied before this, when the drivers are built
 * (`channels/measure.channelDrivers`), so this only decides what to draw, not what exists.
 */
export function channelLinks(drivers: readonly ChannelDriver[]): ChannelLink[] {
    const links: ChannelLink[] = [];
    for (const driver of drivers) {
        const state = driver.link();
        if (state === null) {
            continue;
        }
        links.push({ channel: driver.channel, state });
    }
    return links;
}
