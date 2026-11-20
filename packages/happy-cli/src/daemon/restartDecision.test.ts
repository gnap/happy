import { describe, expect, it } from 'vitest';
import { RESTART_REPEAT_WINDOW_MS } from './restartTracker';
import { restartDecision } from './restartDecision';

const NOW = 1_000_000;

function decide(overrides: Partial<Parameters<typeof restartDecision>[0]> = {}) {
    return restartDecision({
        currentGeneration: 3,
        inFlight: false,
        now: NOW,
        ...overrides,
    });
}

describe('restartDecision', () => {
    it('performs a first restart and returns the next generation', () => {
        expect(decide()).toEqual({ kind: 'proceed', generation: 4 });
    });

    it('performs a restart asked for at the current generation', () => {
        expect(decide({ expectGeneration: 3 })).toEqual({ kind: 'proceed', generation: 4 });
    });

    it('answers a repeat made against the previous generation as already applied', () => {
        expect(decide({ expectGeneration: 2 })).toEqual({ kind: 'already-applied', generation: 3 });
    });

    it('refuses a request ahead of this machine', () => {
        expect(decide({ expectGeneration: 4 })).toEqual({ kind: 'refuse-ahead', currentGeneration: 3 });
    });

    it('reports an in-flight restart rather than performing it again', () => {
        expect(decide({ inFlight: true })).toEqual({ kind: 'in-flight', generation: 3 });
    });

    it('prefers in-flight over already-applied for a caller holding the pre-bump generation', () => {
        // The generation is bumped when the work starts. A caller that read it before the bump
        // must not be told the restart finished while it is still replacing the process.
        expect(decide({ expectGeneration: 2, inFlight: true })).toEqual({ kind: 'in-flight', generation: 3 });
    });

    it('refuses ahead even while another restart is in flight', () => {
        expect(decide({ expectGeneration: 5, inFlight: true })).toEqual({ kind: 'refuse-ahead', currentGeneration: 3 });
    });

    it('treats a generation-less repeat inside the window as done', () => {
        expect(decide({ finishedAt: NOW - 1_000 })).toEqual({ kind: 'already-restarted', generation: 3 });
    });

    it('treats a repeat at the current generation inside the window as done', () => {
        expect(decide({ expectGeneration: 3, finishedAt: NOW - 1_000 })).toEqual({ kind: 'already-restarted', generation: 3 });
    });

    it('performs the restart once the window has run out', () => {
        expect(decide({ finishedAt: NOW - RESTART_REPEAT_WINDOW_MS })).toEqual({ kind: 'proceed', generation: 4 });
    });

    it('does not apply the window when the caller is explicitly behind', () => {
        expect(decide({ expectGeneration: 1, finishedAt: NOW - 1_000 })).toEqual({ kind: 'already-applied', generation: 3 });
    });

    it('honours a caller-supplied window', () => {
        expect(decide({ finishedAt: NOW - 100, repeatWindowMs: 50 })).toEqual({ kind: 'proceed', generation: 4 });
    });
});
