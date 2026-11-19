import { describe, expect, it } from 'vitest';
import {
    PENDING_SESSION_TTL_MS,
    daemonSessionListSignature,
    daemonSessionRows,
    dropDeletedDaemonSessionRows,
    keepPendingDaemonSessionRows,
    mergeSessionRuntime,
    type DaemonSessionReport,
} from './daemonSessionList';

const report = (overrides: Partial<DaemonSessionReport> = {}): DaemonSessionReport => ({
    happySessionId: 'session-1',
    tag: 'tag-1',
    isAlive: true,
    directory: '/work',
    agent: 'claude',
    via: 'lan',
    machineId: 'machine-1',
    ...overrides,
});

describe('daemonSessionRows', () => {
    it('keys a registered row by its server id', () => {
        expect(Object.keys(daemonSessionRows([report()], 10))).toEqual(['session-1']);
    });

    it('keys a scheduled row by its tag, before the server has named it', () => {
        const rows = daemonSessionRows([report({
            happySessionId: undefined,
            isAlive: false,
            phase: 'Scheduling',
            generation: 1,
            reason: 'spawn-pending',
        })], 10);

        expect(rows['tag-1']).toMatchObject({
            tag: 'tag-1',
            isAlive: false,
            phase: 'Scheduling',
            generation: 1,
            reason: 'spawn-pending',
            at: 10,
        });
    });

    it('drops a row with neither name, which nothing could address', () => {
        expect(daemonSessionRows([report({ happySessionId: undefined, tag: undefined })], 10)).toEqual({});
    });

    it('leaves the projection off when an older machine says nothing about it', () => {
        expect(daemonSessionRows([report()], 10)['session-1']).toEqual({
            isAlive: true,
            directory: '/work',
            agent: 'claude',
            via: 'lan',
            machineId: 'machine-1',
            happySessionId: 'session-1',
            tag: 'tag-1',
            at: 10,
        });
    });
});

describe('dropDeletedDaemonSessionRows', () => {
    it('drops a listing that has not replayed the deletion yet', () => {
        expect(dropDeletedDaemonSessionRows([report()], { 'session-1': 100 })).toEqual([]);
    });

    it('keeps a session nothing has deleted', () => {
        expect(dropDeletedDaemonSessionRows([report()], { 'session-2': 100 })).toEqual([report()]);
    });

    it('keeps a scheduled row, which has no id a deletion could name', () => {
        const pending = report({ happySessionId: undefined, tag: 'tag-1', phase: 'Scheduling' });

        expect(dropDeletedDaemonSessionRows([pending], { 'session-1': 100 })).toEqual([pending]);
    });
});

describe('keepPendingDaemonSessionRows', () => {
    const pending = () => daemonSessionRows([report({
        happySessionId: undefined,
        isAlive: false,
        phase: 'Scheduling',
    })], 10);

    it('keeps a scheduled row a server answer cannot know about', () => {
        expect(Object.keys(keepPendingDaemonSessionRows(pending(), 10 + 1_000))).toEqual(['tag-1']);
    });

    it('clears server-named rows, which the server list is the better source for', () => {
        expect(keepPendingDaemonSessionRows(daemonSessionRows([report()], 10), 11)).toEqual({});
    });

    it('drops a scheduled row once the machine would have given up on the spawn', () => {
        expect(keepPendingDaemonSessionRows(pending(), 10 + PENDING_SESSION_TTL_MS)).toEqual({});
    });
});

describe('mergeSessionRuntime', () => {
    it('stores what the machine said, by server id', () => {
        expect(mergeSessionRuntime({}, [{ sessionId: 's1', phase: 'Restarting', generation: 2 }], 10)).toEqual({
            s1: { phase: 'Restarting', generation: 2, at: 10 },
        });
    });

    it('keeps a field a later statement does not mention', () => {
        const first = mergeSessionRuntime({}, [{ sessionId: 's1', phase: 'Restarting', generation: 2 }], 10);

        expect(mergeSessionRuntime(first, [{ sessionId: 's1', generation: 3 }], 20)).toEqual({
            s1: { phase: 'Restarting', generation: 3, at: 20 },
        });
    });

    it('lets a later statement replace a field it does mention', () => {
        const first = mergeSessionRuntime({}, [{ sessionId: 's1', phase: 'Restarting', generation: 2 }], 10);

        expect(mergeSessionRuntime(first, [{ sessionId: 's1', phase: 'Running' }], 20)).toEqual({
            s1: { phase: 'Running', generation: 2, at: 20 },
        });
    });
});

describe('daemonSessionListSignature', () => {
    it('ignores when the answer arrived, so a heartbeat does not redraw the list', () => {
        expect(daemonSessionListSignature(daemonSessionRows([report()], 10)))
            .toBe(daemonSessionListSignature(daemonSessionRows([report()], 20)));
    });

    it('changes when the machine moves the phase', () => {
        expect(daemonSessionListSignature(daemonSessionRows([report({ phase: 'Starting', generation: 2 })], 10)))
            .not.toBe(daemonSessionListSignature(daemonSessionRows([report({ phase: 'Running', generation: 2 })], 10)));
    });

    it('changes when the generation moves, even if the phase reads the same', () => {
        expect(daemonSessionListSignature(daemonSessionRows([report({ phase: 'Restarting', generation: 2 })], 10)))
            .not.toBe(daemonSessionListSignature(daemonSessionRows([report({ phase: 'Restarting', generation: 3 })], 10)));
    });

    it('does not depend on the order the machines answered in', () => {
        const a = daemonSessionRows([report(), report({ happySessionId: 'session-2', tag: 'tag-2' })], 10);
        const b = daemonSessionRows([report({ happySessionId: 'session-2', tag: 'tag-2' }), report()], 10);

        expect(daemonSessionListSignature(a)).toBe(daemonSessionListSignature(b));
    });
});
