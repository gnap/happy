import { describe, expect, it } from 'vitest';
import { findMessageGaps } from './messageGaps';

const at = (site: string, n: number) => ({ writer: { site, n } });


describe('findMessageGaps', () => {
    it('reports the counters missing between two held messages', () => {
        expect(findMessageGaps([at('m', 0), at('m', 3)])).toEqual([{ site: 'm', missing: [1, 2] }]);
    });

    it('says nothing when the counters are contiguous', () => {
        expect(findMessageGaps([at('m', 0), at('m', 1), at('m', 2)])).toEqual([]);
    });

    it('treats each writer independently, in a stable order', () => {
        expect(findMessageGaps([at('b', 5), at('a', 1), at('b', 6), at('a', 3)]))
            .toEqual([{ site: 'a', missing: [2] }]);
    });

    it('ignores records with no stamp rather than inventing a gap', () => {
        expect(findMessageGaps([{}, { writer: undefined }, at('m', 1), at('m', 2)])).toEqual([]);
    });

    it('does not report the edges of the held window as gaps', () => {
        // A window that starts at 10 has not lost 0..9; they are older than it.
        expect(findMessageGaps([at('m', 10), at('m', 11)])).toEqual([]);
    });

    it('is not confused by a duplicate delivery of the same counter', () => {
        expect(findMessageGaps([at('m', 1), at('m', 1), at('m', 3)])).toEqual([{ site: 'm', missing: [2] }]);
    });
});
