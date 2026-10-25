import { describe, expect, it } from 'vitest';
import { collapseDuplicateMessages, mergePageIntoWindow } from './messageIdentity';

const queued = { id: 'local-1', localId: 'local-1', createdAt: 100 };
const echoed = { id: 'server-1', localId: 'local-1', createdAt: 100 };

describe('collapseDuplicateMessages', () => {
    it('collapses the queued copy and the server echo into the copy carrying the server id', () => {
        expect(collapseDuplicateMessages([queued, echoed])).toEqual([echoed]);
    });

    it('does not care which copy came first', () => {
        expect(collapseDuplicateMessages([echoed, queued])).toEqual([echoed]);
    });

    it('keeps one entry where the first delivery stood, so page order is unchanged', () => {
        const other = { id: 'other', localId: null, createdAt: 90 };
        const later = { id: 'other-2', localId: null, createdAt: 110 };
        expect(collapseDuplicateMessages([other, queued, later, echoed])).toEqual([other, echoed, later]);
    });

    it('keeps the later copy when neither carries a server id', () => {
        const first = { id: 'a', localId: 'same', createdAt: 100 };
        const second = { id: 'b', localId: 'same', createdAt: 200 };
        expect(collapseDuplicateMessages([first, second])).toEqual([second]);
    });

    it('leaves messages without a localId alone', () => {
        const a = { id: 'a', localId: null, createdAt: 1 };
        const b = { id: 'b', localId: null, createdAt: 2 };
        expect(collapseDuplicateMessages([a, b])).toEqual([a, b]);
    });

    it('collapses more than two deliveries of one message', () => {
        const third = { id: 'server-1', localId: 'local-1', createdAt: 300 };
        expect(collapseDuplicateMessages([queued, third, echoed])).toEqual([third]);
    });
});

describe('mergePageIntoWindow', () => {
    const held = [
        { id: 'server-1', localId: 'local-1', createdAt: 100 },
        { id: 'server-2', localId: 'local-2', createdAt: 200 },
        { id: 'server-3', localId: 'local-3', createdAt: 300 },
    ];

    it('returns null for a page the window already holds', () => {
        expect(mergePageIntoWindow(held, [...held])).toBeNull();
    });

    it('returns null for a shorter page of the same messages — the shrinking replacement', () => {
        expect(mergePageIntoWindow(held, held.slice(1))).toBeNull();
    });

    it('adds messages the window does not hold, around what it does', () => {
        const fresh = { id: 'server-4', localId: 'local-4', createdAt: 400 };
        const result = mergePageIntoWindow(held, [held[2], fresh]);
        expect(result).not.toBeNull();
        expect(result!.fresh).toBe(1);
        expect(result!.messages).toEqual([...held, fresh]);
    });

    it('merges a non-adjacent page by time rather than replacing the window', () => {
        // The fresh-daemon shape: the page starts after a gap and is shorter than what is held.
        const page = [
            { id: 'daemon-9', localId: 'local-9', createdAt: 250 },
        ];
        const result = mergePageIntoWindow(held, page);
        expect(result!.messages).toHaveLength(4);
        expect(result!.messages.map((m) => m.createdAt)).toEqual([100, 200, 250, 300]);
    });

    it('upgrades a held queued copy to the page copy carrying the server id', () => {
        const window = [
            { id: 'local-2', localId: 'local-2', createdAt: 200 },
        ];
        const page = [
            { id: 'server-2', localId: 'local-2', createdAt: 200 },
        ];
        const result = mergePageIntoWindow(window, page);
        expect(result).toBeNull(); // no *new* message: the caller leaves its state alone
    });

    it('sorts the merged set by createdAt', () => {
        const page = [
            { id: 'daemon-0', localId: 'local-0', createdAt: 50 },
            { id: 'daemon-9', localId: 'local-9', createdAt: 350 },
        ];
        const result = mergePageIntoWindow(held, page);
        expect(result!.messages.map((m) => m.createdAt)).toEqual([50, 100, 200, 300, 350]);
    });
});
