import { describe, it, expect } from 'vitest';
import { sessionStatusOf } from './sessionStatus';

describe('sessionStatusOf', () => {
    it('reads a registered live process as Running', () => {
        const status = sessionStatusOf({
            live: { pid: 10, spawnTime: 1_000, lastHeartbeat: 2_000 },
            registered: true,
            generation: 3,
            now: 5_000,
        });

        expect(status.phase).toBe('Running');
        expect(status.observedAt).toBe(2_000);
        expect(status.observedGeneration).toBe(3);
        expect(status.conditions).toEqual([
            { type: 'Spawned', status: 'True', updatedAt: 1_000 },
            { type: 'Registered', status: 'True', updatedAt: 2_000 },
        ]);
    });

    it('reads a live process the server has not named yet as Starting', () => {
        // The window this exists for: the process exists, but there is no session id to ask for
        // yet. Reporting it Stopped would hide the session at the moment a reader is watching for
        // it to appear.
        const status = sessionStatusOf({
            live: { pid: 10, spawnTime: 1_000 },
            registered: false,
            generation: 2,
            now: 5_000,
        });

        expect(status.phase).toBe('Starting');
        expect(status.observedAt).toBe(1_000);
        expect(status.observedGeneration).toBe(1);
        expect(status.reason).toBe('waiting for the server to name the session');
        expect(status.conditions[1]).toMatchObject({ type: 'Registered', status: 'False' });
    });

    it('lets a restart explain why nothing is alive', () => {
        // The old process is gone and the new one has not registered. Liveness alone would say
        // Stopped for the whole restart, which is the reading restarts were made visible to avoid.
        const status = sessionStatusOf({
            restartingSince: 4_000,
            stored: { status: 'running', lastHeartbeat: 3_000 },
            generation: 5,
            now: 5_000,
        });

        expect(status.phase).toBe('Restarting');
        expect(status.observedAt).toBe(4_000);
        expect(status.observedGeneration).toBe(4);
    });

    it('lets a tombstone overrule every other fact', () => {
        // Archived rows are normally filtered out before projection; when one is projected anyway
        // — a control result answering for an id that was removed mid-flight — the answer must not
        // depend on a stale process or record still lying around.
        const status = sessionStatusOf({
            live: { pid: 10, spawnTime: 1_000 },
            registered: true,
            restartingSince: 4_000,
            stored: { status: 'running' },
            archivedAt: 9_000,
            generation: 7,
            now: 10_000,
        });

        expect(status.phase).toBe('Archived');
        expect(status.observedAt).toBe(9_000);
    });

    it('reads a stored session with no process as Stopped, keeping its exit reason', () => {
        const status = sessionStatusOf({
            stored: { origin: 'daemon', status: 'stopped', exitReason: 'user quit', exitTime: 3_000, updatedAt: 3_500 },
            generation: 2,
            now: 5_000,
        });

        expect(status.phase).toBe('Stopped');
        expect(status.reason).toBe('user quit');
        expect(status.observedAt).toBe(3_000);
        expect(status.conditions[0]).toMatchObject({ type: 'Spawned', status: 'False', reason: 'user quit' });
    });

    it('does not claim imported sessions even though it has a record', () => {
        // The daemon folds the server's catalog in so it can answer *about* sessions it never ran.
        // That record is evidence the session exists, not evidence about its process.
        const status = sessionStatusOf({
            stored: { origin: 'server', updatedAt: 3_000 },
            now: 5_000,
        });

        expect(status.phase).toBe('Unknown');
        expect(status.observedGeneration).toBe(0);
        expect(status.reason).toBe('imported from the server; this machine does not run it');
        expect(status.conditions[0]).toMatchObject({ type: 'Spawned', status: 'False' });
        expect(status.conditions[1]).toMatchObject({ type: 'Registered', status: 'Unknown' });
    });

    it('reads a spec with no process as Scheduling', () => {
        const status = sessionStatusOf({ schedulingSince: 2_000, generation: 1, now: 5_000 });

        expect(status.phase).toBe('Scheduling');
        expect(status.observedAt).toBe(2_000);
        expect(status.observedGeneration).toBe(0);
        expect(status.conditions[0]).toMatchObject({ type: 'Spawned', status: 'False' });
    });

    it('prefers the process once one exists', () => {
        // The spec is cleared when the process takes over; if a caller projects during the
        // overlap, what is running outranks what was asked for.
        const status = sessionStatusOf({
            live: { pid: 10, spawnTime: 3_000 },
            schedulingSince: 2_000,
            registered: false,
            now: 5_000,
        });

        expect(status.phase).toBe('Starting');
    });

    it('never reports a negative observed generation', () => {
        // Legacy rows carry no spec at all: generation 0, so "one behind" must clamp.
        const status = sessionStatusOf({ live: { pid: 10, spawnTime: 1_000 }, registered: false, now: 2_000 });

        expect(status.generation).toBe(0);
        expect(status.observedGeneration).toBe(0);
    });

    it('says Unknown when it has heard nothing at all', () => {
        const status = sessionStatusOf({ now: 5_000 });

        expect(status.phase).toBe('Unknown');
        expect(status.observedAt).toBe(5_000);
        expect(status.conditions).toEqual([
            { type: 'Spawned', status: 'Unknown', updatedAt: 5_000 },
            { type: 'Registered', status: 'Unknown', updatedAt: 5_000 },
        ]);
    });

    it('reads a pre-generation stored row as generation 0', () => {
        // Rows written by earlier builds have no `generation`. They are settled, not working.
        const status = sessionStatusOf({ stored: { origin: 'daemon', status: 'running' }, now: 5_000 });

        expect(status.phase).toBe('Stopped');
        expect(status.generation).toBe(0);
        expect(status.observedGeneration).toBe(0);
    });

    it('reports a stopped process below the wanted generation as divergence', () => {
        // A restart was accepted (generation 2) but the record still describes the process that
        // realized generation 1. The row is Stopped and the want is outstanding.
        const status = sessionStatusOf({
            stored: { origin: 'daemon', status: 'stopped', exitTime: 3_000, generation: 1 },
            desired: { lifecycle: 'running', generation: 2, at: 2_000 },
            now: 5_000,
        });

        expect(status.phase).toBe('Stopped');
        expect(status.observedGeneration).toBe(1);
        expect(status.desiredLifecycle).toBe('running');
        expect(status.divergence).toEqual({
            desired: 'running',
            generation: 2,
            reason: 'want-not-observed',
            since: 2_000,
        });
    });

    it('does not call a realized-and-stopped session divergent', () => {
        // There is no "stopped" spec. The process did realize generation 2 before exiting; a
        // later wake is the App's message path, not a missing want.
        const status = sessionStatusOf({
            stored: { origin: 'daemon', status: 'stopped', exitTime: 3_000, generation: 2 },
            desired: { lifecycle: 'running', generation: 2, at: 2_000 },
            now: 5_000,
        });

        expect(status.desiredLifecycle).toBe('running');
        expect(status.divergence).toBeUndefined();
    });

    it('reports an archive whose process is still present as divergence', () => {
        const status = sessionStatusOf({
            live: { pid: 10, spawnTime: 1_000 },
            registered: true,
            stored: { origin: 'daemon', status: 'running', generation: 1 },
            desired: { lifecycle: 'archived', generation: 2, at: 2_000 },
            now: 5_000,
        });

        expect(status.phase).toBe('Running');
        expect(status.divergence).toMatchObject({
            desired: 'archived',
            generation: 2,
            reason: 'spec-archived',
        });
    });

    it('does not report divergence after the archived want is applied', () => {
        const status = sessionStatusOf({
            archivedAt: 4_000,
            desired: { lifecycle: 'archived', generation: 2, at: 2_000 },
            now: 5_000,
        });

        expect(status.phase).toBe('Archived');
        expect(status.desiredLifecycle).toBe('archived');
        expect(status.divergence).toBeUndefined();
    });

    it('lets the reconciler say why it is retrying or blocked', () => {
        const status = sessionStatusOf({
            stored: { origin: 'daemon', status: 'stopped', exitTime: 3_000, generation: 1 },
            desired: { lifecycle: 'running', generation: 2, at: 2_000 },
            reconciliation: { reason: 'spawn-failed', since: 2_500, attempts: 5, blocked: true },
            now: 5_000,
        });

        expect(status.divergence).toEqual({
            desired: 'running',
            generation: 2,
            reason: 'spawn-failed',
            since: 2_500,
            attempts: 5,
            blocked: true,
        });
    });
});
