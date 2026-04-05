import { describe, expect, it } from 'vitest';
import {
    CACHE_SEGMENT_SIZE,
    alignAfterSeq,
    computeBitmap,
    getBitmapSegments,
    olderAfterSeq,
    segmentEnd,
    segmentIndex,
    segmentStart,
} from './cacheSegment';

describe('cacheSegment', () => {
    it('maps sequence numbers to segment boundaries', () => {
        expect(CACHE_SEGMENT_SIZE).toBe(100);
        expect(segmentIndex(1)).toBe(0);
        expect(segmentIndex(100)).toBe(0);
        expect(segmentIndex(101)).toBe(1);
        expect(segmentStart(2)).toBe(201);
        expect(segmentEnd(2)).toBe(300);
    });

    it('aligns afterSeq values for page fetches', () => {
        expect(alignAfterSeq(0)).toBe(0);
        expect(alignAfterSeq(1)).toBe(0);
        expect(alignAfterSeq(250)).toBe(200);
        expect(olderAfterSeq(1)).toBe(0);
        expect(olderAfterSeq(401)).toBe(300);
        expect(olderAfterSeq(451)).toBe(400);
    });

    it('computes cache bitmaps from a loaded range', () => {
        expect(computeBitmap(401, 500, 500)).toBe(0b1);
        expect(computeBitmap(301, 500, 500)).toBe(0b11);
        expect(computeBitmap(1, 99, 99)).toBe(0b1);
    });

    it('expands the bitmap for rendering', () => {
        expect(getBitmapSegments(0b101, 300)).toEqual([true, false, true]);
        expect(getBitmapSegments(0, 0)).toEqual([]);
    });
});
