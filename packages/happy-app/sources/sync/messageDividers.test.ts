import { describe, expect, it } from 'vitest';
import { DIVIDER_GAP_MS, dividerKindFor, formatClock } from './messageDividers';

const at = (iso: string) => new Date(iso).getTime();
const now = at('2026-10-10T12:00:00');

describe('dividerKindFor', () => {
    it('shows a clock divider at the top of the loaded window', () => {
        // Above it the conversation continues into messages this device has not read.
        expect(dividerKindFor(at('2026-10-10T09:30:00'), null, now)).toBe('clock');
        expect(dividerKindFor(at('2026-08-01T09:30:00'), null, now)).toBe('date');
    });

    it('says nothing while a conversation is moving', () => {
        const previous = at('2026-10-10T09:30:00');
        expect(dividerKindFor(previous + 30_000, previous, now)).toBe('none');
        expect(dividerKindFor(previous + DIVIDER_GAP_MS - 1, previous, now)).toBe('none');
    });

    it('marks a pause long enough to be a new thought', () => {
        const previous = at('2026-10-10T09:30:00');
        expect(dividerKindFor(previous + DIVIDER_GAP_MS, previous, now)).toBe('clock');
    });

    it('marks a new day even when the two messages are a minute apart', () => {
        // 23:59 → 00:00 is one minute and a different day.
        expect(dividerKindFor(at('2026-10-10T00:00:30'), at('2026-10-09T23:59:30'), now)).toBe('clock');
    });

    it('names yesterday and dates older than that', () => {
        expect(dividerKindFor(at('2026-10-09T22:00:00'), at('2026-10-09T21:00:00'), now)).toBe('yesterday');
        expect(dividerKindFor(at('2026-10-01T09:00:00'), null, now)).toBe('date');
    });
});

describe('formatClock', () => {
    it('pads to a fixed width', () => {
        expect(formatClock(at('2026-10-10T09:05:00'))).toBe('09:05');
        expect(formatClock(at('2026-10-10T18:30:00'))).toBe('18:30');
    });
});
