import { describe, expect, it } from 'vitest';
import { diffMessages } from './sessionCacheDB';

const m = (id: string) => ({ id, createdAt: 1 });

describe('diffMessages', () => {
    it('rewrites the session when the rows on disk are unknown', () => {
        const messages = [m('a'), m('b')];
        expect(diffMessages(undefined, messages)).toMatchObject({
            inserts: messages,
            removed: [],
            rewrite: true,
        });
    });

    it('writes nothing when the same objects come back', () => {
        const messages = [m('a'), m('b')];
        const previous = new Map(messages.map((message) => [message.id, message]));
        expect(diffMessages(previous, messages)).toMatchObject({ inserts: [], removed: [], rewrite: false });
    });

    it('writes only what changed, including a message replaced by a new object', () => {
        const first = m('a');
        const unchanged = m('b');
        const previous = new Map([['a', first], ['b', unchanged]]);
        const changed = m('a');
        const added = m('c');

        const diff = diffMessages(previous, [changed, unchanged, added]);
        expect(diff.inserts).toEqual([changed, added]);
        expect(diff.removed).toEqual([]);
        expect(diff.rewrite).toBe(false);
    });

    it('deletes the rows of messages the window no longer holds', () => {
        const kept = m('a');
        const dropped = m('b');
        const previous = new Map([['a', kept], ['b', dropped]]);

        const diff = diffMessages(previous, [kept]);
        expect(diff.inserts).toEqual([]);
        expect(diff.removed).toEqual(['b']);
    });

    it('carries the written set forward, so the next save diffs against this one', () => {
        const one = m('a');
        const diff = diffMessages(undefined, [one]);
        // The next save sees the same object and writes nothing — which is the whole point.
        expect(diffMessages(diff.next, [one]).inserts).toEqual([]);
    });
});
