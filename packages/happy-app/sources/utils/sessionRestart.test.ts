import { describe, expect, it } from 'vitest';
import { RESTART_GRACE_MS, restartWithinGrace, sessionIsRestarting } from './sessionRestart';

const asked = { 'sess-1': 1_000_000 };

describe('sessionIsRestarting', () => {
    it('holds for a restart that was just asked for', () => {
        expect(sessionIsRestarting('sess-1', asked, 1_000_000)).toBe(true);
        // The middle of the window, where a restart actually takes place.
        expect(sessionIsRestarting('sess-1', asked, 1_000_000 + RESTART_GRACE_MS / 2)).toBe(true);
    });

    it('stops holding once the grace has run out', () => {
        // The point of the window ending: a restart that never brought the session back must stop
        // being reported as in progress, or a session that is simply gone reads as one that is
        // still coming.
        expect(sessionIsRestarting('sess-1', asked, 1_000_000 + RESTART_GRACE_MS)).toBe(false);
        expect(sessionIsRestarting('sess-1', asked, 1_000_000 + RESTART_GRACE_MS * 10)).toBe(false);
    });

    it('says nothing about a session nobody restarted', () => {
        expect(sessionIsRestarting('other', asked, 1_000_000)).toBe(false);
        expect(sessionIsRestarting('sess-1', {}, 1_000_000)).toBe(false);
    });

    it('counts from the ask, so a later restart starts a new window', () => {
        // Two restarts in a row: the second is what the reader is waiting for, and the grace must
        // not expire while it is still running because the first one started the clock.
        const second = { 'sess-1': 1_000_000 + RESTART_GRACE_MS };
        expect(sessionIsRestarting('sess-1', second, 1_000_000 + RESTART_GRACE_MS + 1)).toBe(true);
    });
});

describe('restartWithinGrace', () => {
    it('treats an unknown ask as no restart at all', () => {
        expect(restartWithinGrace(undefined, 1_000_000)).toBe(false);
    });

    it('agrees with the session-shaped check it is built on', () => {
        // The store prunes with this one and draws with the other; a disagreement between them
        // would leave entries that are kept but never shown, or shown after being dropped.
        const now = 1_000_000 + RESTART_GRACE_MS - 1;
        expect(restartWithinGrace(asked['sess-1'], now)).toBe(sessionIsRestarting('sess-1', asked, now));
    });
});
