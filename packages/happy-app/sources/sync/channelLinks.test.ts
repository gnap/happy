import { describe, expect, it } from 'vitest';
import { channelLinks, type ChannelFacts } from './channelLinks';

const facts = (over: Partial<ChannelFacts> = {}): ChannelFacts => ({
    serverStatus: 'connected',
    lanSocket: false,
    lanSeen: false,
    relayConnected: false,
    ...over,
});

describe('channelLinks', () => {
    it('shows the relay whenever it is switched on, because that is the channel being on', () => {
        // The relay icon is the App's one connection to the relay — not the per-machine streams it
        // carries, which exist only while a session is being read over one. Reporting it as absent
        // whenever no stream happened to be open is what made the relay look eaten.
        expect(channelLinks(['lan', 'relay', 'server'], facts({ relayConnected: true }))).toEqual([
            { channel: 'relay', state: 'connected' },
            { channel: 'server', state: 'connected' },
        ]);
        expect(channelLinks(['lan', 'relay', 'server'], facts())).toEqual([
            { channel: 'relay', state: 'connecting' },
            { channel: 'server', state: 'connected' },
        ]);
    });

    it('keeps the order the priority setting gives', () => {
        expect(channelLinks(['relay', 'lan', 'server'], facts({ relayConnected: true, lanSeen: true })).map((l) => l.channel))
            .toEqual(['relay', 'lan', 'server']);
    });

    it('hides the LAN icon until this device has seen a machine on the network', () => {
        expect(channelLinks(['lan', 'server'], facts()).map((l) => l.channel)).toEqual(['server']);
        expect(channelLinks(['lan', 'server'], facts({ lanSeen: true }))).toEqual([
            { channel: 'lan', state: 'connecting' },
            { channel: 'server', state: 'connected' },
        ]);
        expect(channelLinks(['lan', 'server'], facts({ lanSocket: true }))[0]).toEqual({ channel: 'lan', state: 'connected' });
    });

    it('falls back to the default set rather than showing no channels at all', () => {
        // The stored value is what a device last saved; blanked or unreadable, the header still has
        // to say something, or a channel that is on looks like a channel that does not exist.
        // The LAN entry is still hidden — nothing has been seen on this network — but the relay and
        // the server are there, which is the point: the channels that are on must not vanish.
        // The default order is lan › server › relay, and the LAN entry is still hidden because
        // nothing has been seen on this network.
        expect(channelLinks([], facts({ relayConnected: true })).map((l) => l.channel)).toEqual(['server', 'relay']);
        expect(channelLinks(['nonsense'] as never, facts()).map((l) => l.channel)).toEqual(['server', 'relay']);
    });

    it('reports the server channel as down when the socket is not up', () => {
        expect(channelLinks(['server'], facts({ serverStatus: 'connecting' }))).toEqual([{ channel: 'server', state: 'connecting' }]);
        expect(channelLinks(['server'], facts({ serverStatus: 'error' }))).toEqual([{ channel: 'server', state: 'disconnected' }]);
    });
});
