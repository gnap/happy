import { describe, expect, it } from 'vitest';
import { fieldMatches, nextCronFire } from './cron';
import { formatCountdown } from '@/hooks/useCountdown';

/** A local-time moment, so the assertions read as wall-clock times rather than UTC offsets. */
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).getTime();
const show = (ms: number | null) => (ms === null ? null : new Date(ms).toLocaleString('sv-SE'));

describe('fieldMatches', () => {
    it('understands the forms a schedule actually uses', () => {
        expect(fieldMatches('*', 42, 0, 59)).toBe(true);
        expect(fieldMatches('5', 5, 0, 59)).toBe(true);
        expect(fieldMatches('5', 6, 0, 59)).toBe(false);
        expect(fieldMatches('1-5', 3, 0, 6)).toBe(true);
        expect(fieldMatches('1-5', 6, 0, 6)).toBe(false);
        expect(fieldMatches('*/15', 30, 0, 59)).toBe(true);
        expect(fieldMatches('*/15', 31, 0, 59)).toBe(false);
        expect(fieldMatches('10-20/5', 15, 0, 59)).toBe(true);
        expect(fieldMatches('10-20/5', 16, 0, 59)).toBe(false);
        expect(fieldMatches('1,20,40', 20, 0, 59)).toBe(true);
        expect(fieldMatches('abc', 1, 0, 59)).toBe(false);
    });
});

describe('nextCronFire', () => {
    it('finds today when the time is still ahead, tomorrow when it is not', () => {
        expect(show(nextCronFire('0 9 * * *', at(2026, 10, 26, 8, 0)))).toBe('2026-10-26 09:00:00');
        expect(show(nextCronFire('0 9 * * *', at(2026, 10, 26, 10, 0)))).toBe('2026-10-27 09:00:00');
    });

    it('lands on the next step of a stepped minute field', () => {
        expect(show(nextCronFire('*/15 * * * *', at(2026, 10, 26, 10, 7)))).toBe('2026-10-26 10:15:00');
    });

    it('respects weekday ranges', () => {
        // 2026-10-23 is a Friday; the next weekday 09:00 is Monday the 26th.
        expect(show(nextCronFire('0 9 * * 1-5', at(2026, 10, 23, 10, 0)))).toBe('2026-10-26 09:00:00');
    });

    it('reads an explicit date as its next occurrence, which a one-shot view must guard', () => {
        expect(show(nextCronFire('0 9 26 10 *', at(2026, 10, 25, 12, 0)))).toBe('2026-10-26 09:00:00');
        // Past this year's date, the same expression matches next year: the schedule itself has
        // no notion of one-shot, so the caller decides that a past moment is not a countdown.
        expect(show(nextCronFire('0 9 26 10 *', at(2026, 10, 27, 12, 0)))).toBe('2027-10-26 09:00:00');
    });

    it('returns null for an expression it cannot read', () => {
        expect(nextCronFire('not a cron', at(2026, 10, 26, 0, 0))).toBeNull();
    });
});

describe('formatCountdown', () => {
    it('uses the largest unit that still says something, and never reads zero early', () => {
        expect(formatCountdown(44_100)).toBe('45s');
        expect(formatCountdown(192_000)).toBe('3m 12s');
        expect(formatCountdown(3_600_000)).toBe('1h');
        expect(formatCountdown(3_900_000)).toBe('1h 05m');
        expect(formatCountdown(90_000_000)).toBe('1d 1h');
        expect(formatCountdown(-5)).toBe('0s');
    });
});
