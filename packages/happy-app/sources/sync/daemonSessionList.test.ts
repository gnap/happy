import { describe, expect, it } from 'vitest';
import {
    PENDING_SESSION_TTL_MS,
    daemonSessionListSignature,
    daemonSessionRows,
    dropDeletedDaemonSessionRows,
    keepPendingDaemonSessionRows,
    mergeSessionRuntime,
    preferDaemonSessionAnswer,
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

    it('keys a scheduled row by its lineage uid, not the CLI\'s private tag', () => {
        const rows = daemonSessionRows([report({
            happySessionId: undefined,
            sessionUid: 'uid-1',
            isAlive: false,
            phase: 'Scheduling',
            generation: 1,
            reason: 'spawn-pending',
        })], 10);

        expect(Object.keys(rows)).toEqual(['uid-1']);
        expect(rows['uid-1']).toMatchObject({
            tag: 'tag-1',
            sessionUid: 'uid-1',
            phase: 'Scheduling',
            reason: 'spawn-pending',
        });
    });

    it('drops a row with neither name, which nothing could address', () => {
        expect(daemonSessionRows([report({ happySessionId: undefined, tag: undefined })], 10)).toEqual({});
    });

    it('carries the want beside the observation, including a stuck one', () => {
        const rows = daemonSessionRows([report({
            phase: 'Stopped',
            generation: 4,
            observedGeneration: 3,
            desiredLifecycle: 'running',
            divergence: {
                desired: 'running',
                generation: 4,
                reason: 'want-not-observed',
                since: 1_000,
                attempts: 5,
                blocked: true,
            },
        })], 10);

        expect(rows['session-1']).toMatchObject({
            desiredLifecycle: 'running',
            divergence: { generation: 4, blocked: true, attempts: 5 },
        });
    });

    it('carries the lineage uid beside the server id', () => {
        // The id may change; the uid is what a deletion can name the conversation by.
        const rows = daemonSessionRows([report({ sessionUid: 'uid-1' })], 10);

        expect(rows['session-1'].sessionUid).toBe('uid-1');
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

    it('drops the same lineage offered under a server id issued after the delete', () => {
        // The person deleted the conversation, not the id it happened to be wearing. A resumed
        // session can come back under a new id, and the uid is what still identifies it.
        const resumed = report({ happySessionId: 'session-2', sessionUid: 'uid-1' });

        expect(dropDeletedDaemonSessionRows([resumed], {}, { 'uid-1': 100 })).toEqual([]);
    });

    it('keeps a row whose lineage nothing deleted', () => {
        const other = report({ sessionUid: 'uid-2' });

        expect(dropDeletedDaemonSessionRows([other], {}, { 'uid-1': 100 })).toEqual([other]);
    });

    it('treats an absent uid as nothing to match, so an older machine keeps its row', () => {
        expect(dropDeletedDaemonSessionRows([report()], {}, { 'uid-1': 100 })).toEqual([report()]);
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

describe('preferDaemonSessionAnswer', () => {
    const answer = (
        summary: {
            origin?: 'daemon' | 'server';
            phase?: string;
            generation?: number;
            observedGeneration?: number;
            observedAt?: number;
        },
        machineId = 'machine-1',
    ) => ({ summary, machineId, via: 'lan' as const });

    it('takes the first answer when there is nothing to compare', () => {
        const candidate = answer({ origin: 'daemon', generation: 2 });

        expect(preferDaemonSessionAnswer(undefined, candidate)).toBe(candidate);
    });

    it('keeps the owner over an importer even when the importer looks newer', () => {
        const owner = answer({ origin: 'daemon', generation: 2, observedGeneration: 2, observedAt: 100 });
        const importer = answer({ origin: 'server', generation: 3, observedGeneration: 3, observedAt: 200 }, 'machine-2');

        expect(preferDaemonSessionAnswer(owner, importer)).toBe(owner);
    });

    it('lets the owner replace an importer whatever the versions say', () => {
        const importer = answer({ origin: 'server', generation: 3, observedGeneration: 3, observedAt: 200 }, 'machine-2');
        const owner = answer({ origin: 'daemon', generation: 2, observedGeneration: 2, observedAt: 100 });

        expect(preferDaemonSessionAnswer(importer, owner)).toBe(owner);
    });

    it('orders two answers from the same side by version, not by arrival', () => {
        const older = answer({ origin: 'daemon', generation: 2, observedGeneration: 1, observedAt: 100 });
        const newer = answer({ origin: 'daemon', generation: 2, observedGeneration: 2, observedAt: 50 }, 'machine-2');

        expect(preferDaemonSessionAnswer(older, newer)).toBe(newer);
        expect(preferDaemonSessionAnswer(newer, older)).toBe(newer);
    });

    it('keeps the first answer when the versions are equal or cannot be ordered', () => {
        const first = answer({ origin: 'daemon', generation: 2, observedGeneration: 2, observedAt: 100 });
        const repeat = answer({ origin: 'daemon', generation: 2, observedGeneration: 2, observedAt: 100 }, 'machine-2');
        const unversioned = answer({ origin: 'daemon', phase: 'Running' }, 'machine-2');

        expect(preferDaemonSessionAnswer(first, repeat)).toBe(first);
        expect(preferDaemonSessionAnswer(first, unversioned)).toBe(first);
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

    it('keeps an outstanding want when a statement does not mention it', () => {
        const divergence = { desired: 'running', generation: 2, reason: 'in-flight', since: 10 };
        const first = mergeSessionRuntime({}, [{ sessionId: 's1', phase: 'Starting', divergence }], 10);

        expect(mergeSessionRuntime(first, [{ sessionId: 's1', phase: 'Starting' }], 20)).toEqual({
            s1: { phase: 'Starting', divergence, at: 20 },
        });
    });

    it('clears a want the listing says the facts have caught up with', () => {
        // A divergence is the one projection that has to be removable: unlike a phase, it stops
        // being true. The listing is complete, so its `null` is the statement that it is over.
        const first = mergeSessionRuntime({}, [{
            sessionId: 's1',
            phase: 'Stopped',
            divergence: { desired: 'running', generation: 2, reason: 'want-not-observed', since: 10 },
        }], 10);

        expect(mergeSessionRuntime(first, [{ sessionId: 's1', phase: 'Running', divergence: null }], 20)).toEqual({
            s1: { phase: 'Running', at: 20 },
        });
    });

    it('ignores a statement from an older generation, whatever channel carried it', () => {
        const current = mergeSessionRuntime({}, [{
            sessionId: 's1',
            phase: 'Stopped',
            generation: 3,
            observedGeneration: 2,
            observedAt: 100,
            reason: 'want-not-observed',
            divergence: { desired: 'running', generation: 3, reason: 'want-not-observed', since: 100 },
        }], 10);

        // An answer captured before the machine moved to generation 3 and delivered afterwards.
        // The version, not the arrival, says it is stale; even the `null` it carries is dropped.
        expect(mergeSessionRuntime(current, [{
            sessionId: 's1',
            phase: 'Running',
            generation: 2,
            observedGeneration: 2,
            observedAt: 200,
            divergence: null,
        }], 20)).toEqual(current);
    });

    it('does not let a stale statement revive a want that was realized', () => {
        const current = mergeSessionRuntime({}, [{
            sessionId: 's1',
            phase: 'Running',
            generation: 3,
            observedGeneration: 3,
            observedAt: 100,
            divergence: null,
        }], 10);

        expect(mergeSessionRuntime(current, [{
            sessionId: 's1',
            phase: 'Stopped',
            generation: 2,
            observedGeneration: 1,
            observedAt: 200,
            divergence: { desired: 'running', generation: 2, reason: 'want-not-observed', since: 50 },
        }], 20)).toEqual(current);
    });

    it('lets a newer observation at the same generation win', () => {
        const current = mergeSessionRuntime({}, [{
            sessionId: 's1',
            phase: 'Restarting',
            generation: 3,
            observedGeneration: 3,
            observedAt: 100,
        }], 10);

        expect(mergeSessionRuntime(current, [{
            sessionId: 's1',
            phase: 'Running',
            generation: 3,
            observedGeneration: 3,
            observedAt: 200,
        }], 20)).toEqual({
            s1: {
                phase: 'Running',
                generation: 3,
                observedGeneration: 3,
                observedAt: 200,
                at: 20,
            },
        });
    });

    it('ignores an observation at the same generation that was taken earlier', () => {
        const current = mergeSessionRuntime({}, [{
            sessionId: 's1',
            phase: 'Running',
            generation: 3,
            observedGeneration: 3,
            observedAt: 200,
        }], 10);

        expect(mergeSessionRuntime(current, [{
            sessionId: 's1',
            phase: 'Restarting',
            generation: 3,
            observedGeneration: 3,
            observedAt: 100,
        }], 20)).toEqual(current);
    });

    it('prefers the higher observation even when its timestamp is older', () => {
        // Seeing generation 3 is the newer fact; the timestamp only orders two statements that
        // saw the same thing.
        const current = mergeSessionRuntime({}, [{
            sessionId: 's1',
            phase: 'Starting',
            generation: 3,
            observedGeneration: 2,
            observedAt: 200,
        }], 10);

        expect(mergeSessionRuntime(current, [{
            sessionId: 's1',
            phase: 'Running',
            generation: 3,
            observedGeneration: 3,
            observedAt: 100,
        }], 20)).toEqual({
            s1: {
                phase: 'Running',
                generation: 3,
                observedGeneration: 3,
                observedAt: 100,
                at: 20,
            },
        });
    });

    it('caps an old daemon\'s optimistic Restarting frame at the generation it can have observed', () => {
        // A build before the announcement carried a real observation said the wanted generation
        // was already observed here. Kept as stated, that frame would outrank the listing that
        // reports the restart failed.
        const optimistic = mergeSessionRuntime({}, [{
            sessionId: 's1',
            phase: 'Restarting',
            generation: 4,
            observedGeneration: 4,
            observedAt: 100,
        }], 10);

        expect(optimistic.s1.observedGeneration).toBe(3);
        expect(mergeSessionRuntime(optimistic, [{
            sessionId: 's1',
            phase: 'Stopped',
            generation: 4,
            observedGeneration: 3,
            observedAt: 200,
            divergence: { desired: 'running', generation: 4, reason: 'want-not-observed', since: 150 },
        }], 20)).toMatchObject({
            s1: { phase: 'Stopped', generation: 4, observedGeneration: 3, at: 20 },
        });
    });

    it('does not depend on the order the statements arrive in, or on a repeat', () => {
        const older = {
            sessionId: 's1',
            phase: 'Starting',
            generation: 2,
            observedGeneration: 1,
            observedAt: 100,
        };
        const newer = {
            sessionId: 's1',
            phase: 'Running',
            generation: 2,
            observedGeneration: 2,
            observedAt: 50,
        };

        const forward = mergeSessionRuntime({}, [older, newer], 10);
        const reverse = mergeSessionRuntime({}, [newer, older], 10);

        expect(reverse).toEqual(forward);
        expect(mergeSessionRuntime(forward, [older, newer], 10)).toEqual(forward);
    });

    it('keeps merging additively when a statement has no version', () => {
        // An older daemon says only what it knows how to say. It has no place on the version
        // axis, so the fields it does carry still apply — the alternative would silently drop
        // every update from every machine that predates the tuple.
        const current = mergeSessionRuntime({}, [{
            sessionId: 's1',
            phase: 'Running',
            generation: 3,
            observedGeneration: 3,
            observedAt: 100,
        }], 10);

        expect(mergeSessionRuntime(current, [{ sessionId: 's1', phase: 'Stopped', reason: 'no process' }], 20)).toEqual({
            s1: {
                phase: 'Stopped',
                generation: 3,
                observedGeneration: 3,
                observedAt: 100,
                reason: 'no process',
                at: 20,
            },
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

    it('changes when a want goes from retrying to stuck', () => {
        const divergence = { desired: 'running', generation: 2, reason: 'want-not-observed', since: 10 };
        const retrying = daemonSessionRows([report({ phase: 'Stopped', generation: 2, divergence })], 10);
        const blocked = daemonSessionRows([report({
            phase: 'Stopped',
            generation: 2,
            divergence: { ...divergence, attempts: 5, blocked: true },
        })], 10);

        expect(daemonSessionListSignature(retrying)).not.toBe(daemonSessionListSignature(blocked));
    });

    it('does not depend on the order the machines answered in', () => {
        const a = daemonSessionRows([report(), report({ happySessionId: 'session-2', tag: 'tag-2' })], 10);
        const b = daemonSessionRows([report({ happySessionId: 'session-2', tag: 'tag-2' }), report()], 10);

        expect(daemonSessionListSignature(a)).toBe(daemonSessionListSignature(b));
    });
});
