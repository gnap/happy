import { describe, expect, it } from 'vitest';
import { channelLinks } from './channelLinks';
import type { ChannelDriver, ChannelLinkState } from './channels/types';

/** A channel that says exactly this about its own link. */
const driver = (channel: ChannelDriver['channel'], state: ChannelLinkState | null): ChannelDriver => ({
    channel,
    link: () => state,
    session: () => null,
    machine: () => null,
    capable: () => false,
});

describe('channelLinks', () => {
    it('draws each channel the way that channel says it is doing', () => {
        expect(channelLinks([
            driver('relay', 'connected'),
            driver('server', 'connected'),
        ])).toEqual([
            { channel: 'relay', state: 'connected' },
            { channel: 'server', state: 'connected' },
        ]);
    });

    it('keeps the order it was handed', () => {
        // The order is the priority setting, applied when the drivers are built — this only draws.
        expect(channelLinks([
            driver('relay', 'connecting'),
            driver('lan', 'connected'),
            driver('server', 'connected'),
        ]).map((l) => l.channel)).toEqual(['relay', 'lan', 'server']);
    });

    it('leaves out a channel that has nothing to say about itself', () => {
        // Not the same as "off": a channel that says null has no business being drawn at all — the
        // LAN, on a network nothing has been seen on. An icon there would claim a channel that has
        // never had anything to talk to.
        expect(channelLinks([
            driver('lan', null),
            driver('server', 'connected'),
        ])).toEqual([{ channel: 'server', state: 'connected' }]);
    });

    it('draws a channel that is switched on and not yet reached', () => {
        // The relay is its one connection to the hub: while it is on and not yet reached, the App is
        // trying, which is the blue rather than the grey.
        expect(channelLinks([
            driver('relay', 'connecting'),
            driver('server', 'off'),
        ])).toEqual([
            { channel: 'relay', state: 'connecting' },
            { channel: 'server', state: 'off' },
        ]);
    });
});
