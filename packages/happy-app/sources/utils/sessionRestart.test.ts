import { describe, expect, it } from 'vitest';
import { RESTART_GRACE_MS, restartWithinGrace, sessionIsRestarting } from './sessionRestart';

const T0 = 1_000_000;

describe('sessionIsRestarting', () => {
    it('holds for a restart the machine has announced, whoever asked for it', () => {
        // The whole point: this device may never have asked, and it must still not draw the session
        // as stopped while the machine restarts it.
        expect(sessionIsRestarting({ restartingAt: T0 }, T0)).toBe(true);
        expect(sessionIsRestarting({ restartingAt: T0 }, T0 + RESTART_GRACE_MS / 2)).toBe(true);
    });

    it('stops holding once the grace has run out', () => {
        // The point of the window ending: a restart that never brought the session back must stop
        // being reported as in progress, or a session that is simply gone reads as one still coming.
        // This is also what covers a clear that never arrived.
        expect(sessionIsRestarting({ restartingAt: T0 }, T0 + RESTART_GRACE_MS)).toBe(false);
        expect(sessionIsRestarting({ restartingAt: T0 }, T0 + RESTART_GRACE_MS * 10)).toBe(false);
    });

    it('says nothing about a session nothing has said anything about', () => {
        // Absent and null are the same reading here, and both are the common case.
        expect(sessionIsRestarting({}, T0)).toBe(false);
        expect(sessionIsRestarting({ restartingAt: null }, T0)).toBe(false);
    });

    it('counts from the announcement, so a second restart starts a new window', () => {
        // Two restarts in a row: the second is what the reader is waiting for, and the grace must
        // not expire while it is still running because the first one started the clock.
        expect(sessionIsRestarting({ restartingAt: T0 + RESTART_GRACE_MS }, T0 + RESTART_GRACE_MS + 1)).toBe(true);
    });
});

describe('restartWithinGrace', () => {
    it('treats a missing write as no restart at all', () => {
        expect(restartWithinGrace(undefined, T0)).toBe(false);
        expect(restartWithinGrace(null, T0)).toBe(false);
    });

    it('agrees with the session-shaped check it is built on', () => {
        // The listing applies this and the status line applies the other; a disagreement between
        // them would show a session as restarting in one and not in the other.
        const now = T0 + RESTART_GRACE_MS - 1;
        expect(restartWithinGrace(T0, now)).toBe(sessionIsRestarting({ restartingAt: T0 }, now));
    });
});
