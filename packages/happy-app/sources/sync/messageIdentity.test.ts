import { describe, expect, it } from 'vitest';
import { collapseDuplicateMessages } from './messageIdentity';

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
