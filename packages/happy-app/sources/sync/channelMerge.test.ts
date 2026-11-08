import { describe, expect, it } from 'vitest';
import { mergeChannels, type ChannelMessage } from './channelMerge';

/** Minimal message type — the merge only ever reads the envelope, not the payload. */
type Msg = { text: string };

function msg(over: Partial<ChannelMessage<Msg>> & { id: string }): ChannelMessage<Msg> {
    return {
        item: { text: over.id },
        localId: null,
        createdAt: 0,
        identity: null,
        ...over,
    };
}

describe('mergeChannels', () => {
    it('returns the server list untouched when the LAN has nothing', () => {
        const server = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'b', createdAt: 2 })];
        expect(mergeChannels(server, []).map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('appends messages only the LAN has', () => {
        const server = [msg({ id: 'a', createdAt: 1 })];
        const lan = [msg({ id: 'b', createdAt: 2 })];
        expect(mergeChannels(server, lan).map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('drops a message both channels carried, matching on localId', () => {
        // The same ciphertext arrives down both routes; localId is what proves it is one message.
        const server = [msg({ id: 'srv-1', localId: 'local-1', createdAt: 1 })];
        const lan = [msg({ id: 'local-1', localId: 'local-1', createdAt: 1 })];
        const merged = mergeChannels(server, lan);
        expect(merged).toHaveLength(1);
        expect(merged[0].id).toBe('srv-1'); // server's copy wins, so ids stay stable
    });

    it('matches on (site, n) when a record has no localId to match on', () => {
        const server = [msg({ id: 'srv-1', createdAt: 1, identity: { site: 'm', n: 5 } })];
        const lan = [msg({ id: 'log-1', createdAt: 1, identity: { site: 'm', n: 5 } })];
        expect(mergeChannels(server, lan)).toHaveLength(1);
    });

    it('treats a localId match as also claiming the writer key, and vice versa', () => {
        // A LAN-only copy that shares localId with a server copy, plus a third copy that shares
        // only the writer key with it: all three are the same message, so only one survives.
        const server = [msg({ id: 'srv-1', localId: 'local-1', createdAt: 1, identity: { site: 'm', n: 5 } })];
        const lan = [
            msg({ id: 'log-1', localId: 'local-1', createdAt: 1, identity: { site: 'm', n: 5 } }),
            msg({ id: 'dup-1', createdAt: 1, identity: { site: 'm', n: 5 } }),
        ];
        expect(mergeChannels(server, lan)).toHaveLength(1);
    });

    it('falls back to the raw id when a record has neither localId nor a writer key', () => {
        const server = [msg({ id: 'old-1', createdAt: 1 })];
        const lan = [msg({ id: 'old-1', createdAt: 1 })];
        expect(mergeChannels(server, lan)).toHaveLength(1);
    });

    it('keeps genuinely different messages that happen to share a timestamp', () => {
        const server = [msg({ id: 'a', createdAt: 7 })];
        const lan = [msg({ id: 'b', createdAt: 7 })];
        expect(mergeChannels(server, lan)).toHaveLength(2);
    });

    it('orders by createdAt across writers', () => {
        const server = [msg({ id: 'b', createdAt: 20, identity: { site: 'm1', n: 99 } })];
        const lan = [msg({ id: 'a', createdAt: 10, identity: { site: 'm2', n: 1 } })];
        // m2:n=1 is a *lower* counter but a *later* writer — ordering by n across sites would put
        // it first, which is meaningless. createdAt is the only cross-writer truth.
        expect(mergeChannels(server, lan).map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('breaks a same-timestamp tie within one writer by n', () => {
        const server = [msg({ id: 'second', createdAt: 5, identity: { site: 'm', n: 2 } })];
        const lan = [msg({ id: 'first', createdAt: 5, identity: { site: 'm', n: 1 } })];
        expect(mergeChannels(server, lan).map((m) => m.id)).toEqual(['first', 'second']);
    });

    it('does not let a missing n reorder anything', () => {
        const server = [msg({ id: 'stamped', createdAt: 5, identity: { site: 'm', n: 2 } })];
        const lan = [msg({ id: 'unstamped', createdAt: 5 })];
        // Neither direction of comparison is available, so the input order is preserved rather
        // than guessed at.
        expect(mergeChannels(server, lan)).toHaveLength(2);
    });

    it('is stable when the LAN repeats a whole page the server already gave', () => {
        const server = [
            msg({ id: 's1', localId: 'l1', createdAt: 1, identity: { site: 'm', n: 1 } }),
            msg({ id: 's2', localId: 'l2', createdAt: 2, identity: { site: 'm', n: 2 } }),
        ];
        const lan = [
            msg({ id: 'l1', localId: 'l1', createdAt: 1, identity: { site: 'm', n: 1 } }),
            msg({ id: 'l2', localId: 'l2', createdAt: 2, identity: { site: 'm', n: 2 } }),
        ];
        const merged = mergeChannels(server, lan);
        expect(merged.map((m) => m.id)).toEqual(['s1', 's2']);
    });
});
