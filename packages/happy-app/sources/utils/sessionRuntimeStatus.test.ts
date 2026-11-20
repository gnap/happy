import { describe, expect, it } from 'vitest';
import { RUNTIME_APPLYING_TTL_MS, sessionRuntimeDisplay } from './sessionRuntimeStatus';
import type { SessionRuntimeEntry } from '@/sync/daemonSessionList';

const entry = (overrides: Partial<SessionRuntimeEntry> = {}): SessionRuntimeEntry => ({
    at: 1_000,
    phase: 'Restarting',
    divergence: {
        desired: 'running',
        generation: 2,
        reason: 'in-flight',
        since: 900,
    },
    ...overrides,
});

describe('sessionRuntimeDisplay', () => {
    it('draws nothing without a statement or without a want', () => {
        expect(sessionRuntimeDisplay(undefined, 2_000)).toBeUndefined();
        expect(sessionRuntimeDisplay(entry({ divergence: undefined }), 2_000)).toBeUndefined();
    });

    it('draws a want still being applied', () => {
        expect(sessionRuntimeDisplay(entry(), 2_000)).toEqual({
            kind: 'applying',
            desired: 'running',
            phase: 'Restarting',
        });
    });

    it('draws an archive on its way out as archiving, not as starting', () => {
        expect(sessionRuntimeDisplay(entry({
            phase: 'Stopped',
            divergence: { desired: 'archived', generation: 3, reason: 'spec-archived', since: 900 },
        }), 2_000)).toEqual({
            kind: 'applying',
            desired: 'archived',
            phase: 'Stopped',
        });
    });

    it('stops drawing progress once the machine has gone quiet', () => {
        const at = RUNTIME_APPLYING_TTL_MS - 1;
        expect(sessionRuntimeDisplay(entry({ at: 0 }), at)?.kind).toBe('applying');
        expect(sessionRuntimeDisplay(entry({ at: 0 }), RUNTIME_APPLYING_TTL_MS)).toBeUndefined();
    });

    it('keeps drawing a blocked want however old the statement is', () => {
        expect(sessionRuntimeDisplay(entry({
            at: 0,
            divergence: {
                desired: 'archived',
                generation: 3,
                reason: 'spec-archived',
                since: 900,
                attempts: 5,
                blocked: true,
            },
        }), 10 * RUNTIME_APPLYING_TTL_MS)).toEqual({
            kind: 'blocked',
            desired: 'archived',
            phase: 'Restarting',
        });
    });

    it('keeps a lifecycle this build does not know rather than guessing between the two', () => {
        expect(sessionRuntimeDisplay(entry({
            divergence: { desired: 'paused', generation: 4, reason: 'want-not-observed', since: 900 },
        }), 2_000)).toEqual({
            kind: 'applying',
            desired: 'other',
            phase: 'Restarting',
        });
    });

    it('leaves the phase out when the statement did not carry one', () => {
        expect(sessionRuntimeDisplay(entry({ phase: undefined }), 2_000)).toEqual({
            kind: 'applying',
            desired: 'running',
        });
    });
});
