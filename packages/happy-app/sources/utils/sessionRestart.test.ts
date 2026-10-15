import { describe, expect, it } from 'vitest';
import { RESTART_GRACE_MS, machineIsRestartingSession, restartWithinGrace, sessionIsRestarting } from './sessionRestart';

const T0 = 1_000_000;
const MID = T0 + RESTART_GRACE_MS / 2;
const AFTER = T0 + RESTART_GRACE_MS;

describe('sessionIsRestarting', () => {
    it('holds for a restart this device just asked for', () => {
        expect(sessionIsRestarting('sess-1', { asked: { 'sess-1': T0 } }, T0)).toBe(true);
        expect(sessionIsRestarting('sess-1', { asked: { 'sess-1': T0 } }, MID)).toBe(true);
    });

    it('holds for one another device asked for, because the machine says so', () => {
        // The point of the whole thing: this device never asked, and it must still not draw the
        // session as offline while the machine restarts it.
        const machine = { daemonState: { restartingSessions: { 'sess-1': T0 } } };
        expect(sessionIsRestarting('sess-1', { machine }, MID)).toBe(true);
        expect(sessionIsRestarting('sess-2', { machine }, MID)).toBe(false);
    });

    it('holds for one a daemon answered with directly', () => {
        // The channel case: the server cannot answer, so the daemon was asked instead, and its
        // summary says the session is being restarted rather than merely absent.
        expect(sessionIsRestarting('sess-1', { daemon: { restartingSince: T0 } }, MID)).toBe(true);
    });

    it('stops holding once the grace has run out, from any source', () => {
        // The point of the window ending: a restart that never brought the session back must stop
        // being reported as in progress, or a session that is simply gone reads as one still coming.
        expect(sessionIsRestarting('sess-1', { asked: { 'sess-1': T0 } }, AFTER)).toBe(false);
        expect(sessionIsRestarting('sess-1', { machine: { daemonState: { restartingSessions: { 'sess-1': T0 } } } }, AFTER)).toBe(false);
        expect(sessionIsRestarting('sess-1', { daemon: { restartingSince: T0 } }, AFTER)).toBe(false);
    });

    it('says nothing about a session nobody restarted', () => {
        expect(sessionIsRestarting('other', { asked: { 'sess-1': T0 } }, T0)).toBe(false);
        expect(sessionIsRestarting('sess-1', {}, T0)).toBe(false);
        expect(sessionIsRestarting('sess-1', { asked: {}, machine: null, daemon: null }, T0)).toBe(false);
    });

    it('counts from the ask, so a later restart starts a new window', () => {
        // Two restarts in a row: the second is what the reader is waiting for, and the grace must
        // not expire while it is still running because the first one started the clock.
        expect(sessionIsRestarting('sess-1', { asked: { 'sess-1': AFTER } }, AFTER + 1)).toBe(true);
    });
});

describe('machineIsRestartingSession', () => {
    it('reads the machine state written by the daemon', () => {
        expect(machineIsRestartingSession({ daemonState: { restartingSessions: { a: 5 } } }, 'a')).toBe(5);
        expect(machineIsRestartingSession({ daemonState: { restartingSessions: { a: 5 } } }, 'b')).toBeUndefined();
    });

    it('treats anything unexpected as "not restarting"', () => {
        // Written by another process and carried across a wire: a shape this build does not know is
        // an older daemon or a truncated field, not a reason to say a session is restarting.
        expect(machineIsRestartingSession(undefined, 'a')).toBeUndefined();
        expect(machineIsRestartingSession({ daemonState: null }, 'a')).toBeUndefined();
        expect(machineIsRestartingSession({ daemonState: {} }, 'a')).toBeUndefined();
        expect(machineIsRestartingSession({ daemonState: { restartingSessions: 'nonsense' } }, 'a')).toBeUndefined();
        expect(machineIsRestartingSession({ daemonState: { restartingSessions: ['a'] } }, 'a')).toBeUndefined();
        expect(machineIsRestartingSession({ daemonState: { restartingSessions: { a: 'soon' } } }, 'a')).toBeUndefined();
    });
});

describe('restartWithinGrace', () => {
    it('treats an unknown write as no restart at all', () => {
        expect(restartWithinGrace(undefined, T0)).toBe(false);
    });

    it('agrees with the session-shaped check it is built on', () => {
        // The store prunes with this one and the views draw with the other; a disagreement between
        // them would leave entries that are kept but never shown, or shown after being dropped.
        const now = T0 + RESTART_GRACE_MS - 1;
        expect(restartWithinGrace(T0, now)).toBe(sessionIsRestarting('sess-1', { asked: { 'sess-1': T0 } }, now));
    });
});
