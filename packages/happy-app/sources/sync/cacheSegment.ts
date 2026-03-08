/**
 * Cache segment utilities for the message bitmap tracker.
 *
 * The loaded message range [oldestSeq, newestSeq] is represented as a bitmap
 * where each bit corresponds to a fixed-size segment of CACHE_SEGMENT_SIZE messages.
 * Bit i is set when the segment [segmentStart(i), segmentEnd(i)] is fully present in memory.
 *
 * Alignment rules:
 *  - The LEFT boundary (oldestSeq) must be a segment start. Fetch logic enforces this by
 *    using alignAfterSeq() to round the API afterSeq parameter down to a segment boundary.
 *  - The RIGHT boundary (newestSeq) may be unaligned; the partial rightmost segment is
 *    treated as cached once newestSeq reaches totalSeq (all available messages fetched).
 *
 * Limit: JS bitwise operators are 32-bit signed integers, so we safely track 30 segments
 * (bits 0–29), covering sessions up to 3000 messages. Sessions beyond this still work
 * correctly, but segments ≥ 30 are not represented in the bitmap.
 */

export const CACHE_SEGMENT_SIZE = 100;
export const MAX_TRACKED_SEGMENTS = 30;

/** 0-based segment index for a given sequence number (1-based). */
export function segmentIndex(seq: number): number {
    return Math.floor((seq - 1) / CACHE_SEGMENT_SIZE);
}

/** First (inclusive) seq number in segment idx. */
export function segmentStart(idx: number): number {
    return idx * CACHE_SEGMENT_SIZE + 1;
}

/** Last (inclusive) seq number in a full segment idx. */
export function segmentEnd(idx: number): number {
    return (idx + 1) * CACHE_SEGMENT_SIZE;
}

/**
 * Align an API afterSeq parameter downward so that (afterSeq + 1) falls exactly on a
 * segment boundary. This ensures the fetch window's left edge is segment-aligned and
 * the resulting oldestSeq will be a segment start.
 *
 * Example: afterSeq=250 → fetchStart=251 → segment 2 starts at 201 → returns 200.
 */
export function alignAfterSeq(afterSeq: number): number {
    if (afterSeq <= 0) return 0;
    const fetchStart = afterSeq + 1;
    const seg = segmentIndex(fetchStart);
    return segmentStart(seg) - 1;
}

/**
 * Compute the afterSeq parameter for fetchOlderMessages so the fetch starts at
 * the segment boundary that precedes oldestSeq.
 *
 * The key difference from alignAfterSeq: we want to start at the segment that
 * CONTAINS (oldestSeq - 1), not the segment that starts at oldestSeq itself.
 * This avoids re-fetching the same page when oldestSeq is already at a segment start.
 *
 * Examples:
 *   oldestSeq=401 (seg 4 start) → segmentIndex(400)=3 → afterSeq=300 → fetch 301-400 ✓
 *   oldestSeq=451              → segmentIndex(450)=4 → afterSeq=400 → fetch 401-450 ✓
 *   oldestSeq=101              → segmentIndex(100)=0 → afterSeq=0   → fetch 1-100   ✓
 */
export function olderAfterSeq(oldestSeq: number): number {
    if (oldestSeq <= 1) return 0;
    return segmentStart(segmentIndex(oldestSeq - 1)) - 1;
}

/**
 * Compute the cache bitmap from the currently loaded range [oldestSeq, newestSeq].
 *
 * Segments are numbered FROM THE NEWEST end of the session so the bitmap always
 * covers the most recent 3000 messages regardless of session length:
 *   bit 0 = segment containing totalSeq (newest)
 *   bit 1 = segment immediately before that
 *   …
 *   bit 29 = 30th-newest segment
 *
 * A segment is marked when its entire available range lies within [oldestSeq, newestSeq].
 * The newest segment may be partial (if totalSeq is not a multiple of CACHE_SEGMENT_SIZE);
 * its effective end is min(segmentEnd, totalSeq).
 */
export function computeBitmap(oldestSeq: number, newestSeq: number, totalSeq: number): number {
    if (oldestSeq <= 0 || newestSeq <= 0 || totalSeq <= 0) return 0;

    const newestSeg = segmentIndex(totalSeq); // absolute segment index of the newest message
    let bitmap = 0;

    for (let i = 0; i < MAX_TRACKED_SEGMENTS; i++) {
        const seg = newestSeg - i;
        if (seg < 0) break;

        const start = segmentStart(seg);
        const end = segmentEnd(seg);
        const effectiveEnd = Math.min(end, totalSeq); // cap for partial newest segment

        if (start < oldestSeq) break; // all further segments are also before oldestSeq

        if (newestSeq >= effectiveEnd) {
            bitmap |= (1 << i);
        }
    }
    return bitmap;
}

/**
 * Expand a bitmap into a boolean array for rendering (oldest→newest, left→right).
 *
 * The bitmap uses bit 0 = newest segment, bit N-1 = oldest tracked segment.
 * Display reverses this: index 0 = oldest (left), last index = newest (right).
 */
export function getBitmapSegments(bitmap: number, totalSeq: number): boolean[] {
    if (totalSeq <= 0) return [];
    const totalSegments = Math.min(
        Math.ceil(totalSeq / CACHE_SEGMENT_SIZE),
        MAX_TRACKED_SEGMENTS,
    );
    // bitmapBit 0 = newest (rightmost in bar), so display index i maps to bit (totalSegments-1-i).
    return Array.from({ length: totalSegments }, (_, i) => {
        const bitmapBit = totalSegments - 1 - i;
        return !!(bitmap & (1 << bitmapBit));
    });
}
