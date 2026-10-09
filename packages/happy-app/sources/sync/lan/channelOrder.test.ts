import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL_PRIORITY, normalizeChannelPriority, pickChannel } from './channelOrder';

const all = { lan: true, relay: true, server: true };

describe('normalizeChannelPriority', () => {
    it('keeps a valid subset in order', () => {
        expect(normalizeChannelPriority(['relay', 'lan'])).toEqual(['relay', 'lan']);
    });
    it('drops unknown and repeated entries', () => {
        expect(normalizeChannelPriority(['lan', 'x', 'lan', 'server'])).toEqual(['lan', 'server']);
    });
    it('falls back to the default when nothing usable is left', () => {
        expect(normalizeChannelPriority([])).toEqual(DEFAULT_CHANNEL_PRIORITY);
        expect(normalizeChannelPriority('lan')).toEqual(DEFAULT_CHANNEL_PRIORITY);
    });
});

describe('pickChannel', () => {
    it('takes the first reachable channel in order', () => {
        expect(pickChannel(['relay', 'lan', 'server'], all).channel).toBe('relay');
        expect(pickChannel(['lan', 'server', 'relay'], { ...all, lan: false }).channel).toBe('server');
    });
    it('default order uses the relay only when the server is not reachable', () => {
        const down = { lan: false, relay: true, server: false };
        expect(pickChannel(DEFAULT_CHANNEL_PRIORITY, down).channel).toBe('relay');
        expect(pickChannel(DEFAULT_CHANNEL_PRIORITY, { ...down, server: true }).channel).toBe('server');
    });
    it('never leaves the enabled set, even when nothing is reachable', () => {
        const none = { lan: false, relay: false, server: false };
        expect(pickChannel(['lan'], { ...none, relay: true, server: true })).toEqual({ channel: 'lan', reachable: false });
        expect(pickChannel(['relay', 'server'], none).channel).toBe('relay');
    });
});
