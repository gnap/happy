import { describe, expect, it } from 'vitest';
import { mergeForCache, newestMessages } from './messageMerge';

const message = (id: string, createdAt: number): any => ({ id, localId: id, createdAt });

describe('mergeForCache', () => {
    it('does not delete what a narrower window does not mention', () => {
        // The reported loss: the store held the newest few, the disk held the history, and the save
        // wrote only what the store had.
        const onDisk = [message('a', 1), message('b', 2), message('c', 3)];
        const window = [message('c', 3)];
        expect(mergeForCache(onDisk, window).map((m: any) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('adds what the window knows and the disk does not', () => {
        expect(mergeForCache([message('a', 1)], [message('a', 1), message('b', 2)]).map((m: any) => m.id))
            .toEqual(['a', 'b']);
    });

    it('keeps the copy the store is showing where both have the message', () => {
        const edited = { ...message('a', 1), text: 'final' };
        const merged = mergeForCache([message('a', 1)], [edited]);
        expect(merged).toHaveLength(1);
        expect((merged[0] as any).text).toBe('final');
    });
});

describe('newestMessages', () => {
    it('takes the newest, oldest first — the order the hydration slice expects', () => {
        // The web backend returned the stored array (newest first) and ignored the limit, so the
        // caller's `slice(-60)` took the *oldest* sixty and the next save wrote them over the record.
        const stored = [message('c', 3), message('a', 1), message('b', 2)];
        expect(newestMessages(stored, 2).map((m: any) => m.id)).toEqual(['b', 'c']);
        expect(newestMessages(stored, undefined).map((m: any) => m.id)).toEqual(['a', 'b', 'c']);
    });
});
