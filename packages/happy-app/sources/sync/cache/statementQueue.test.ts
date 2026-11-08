import { describe, expect, it } from 'vitest';
import { StatementQueue } from './statementQueue';

/** A job that records when it started and finished, and can be held open by the test. */
const makeJob = (log: string[], name: string) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return {
        release,
        work: async () => { log.push(`start ${name}`); await gate; log.push(`end ${name}`); },
    };
};

const immediate = (log: string[], name: string) => async () => { log.push(name); };

describe('StatementQueue', () => {
    it('runs one job at a time', async () => {
        const log: string[] = [];
        const queue = new StatementQueue();
        const first = makeJob(log, 'a');
        const started = queue.run(first.work);
        const queued = queue.run(immediate(log, 'b'));
        await Promise.resolve();
        expect(log).toEqual(['start a']);
        first.release();
        await started;
        await queued;
        expect(log).toEqual(['start a', 'end a', 'b']);
    });

    it('takes urgent work before what is behind it, but not before what is running', async () => {
        const log: string[] = [];
        const queue = new StatementQueue();
        const running = makeJob(log, 'running');
        const started = queue.run(running.work);
        const background = queue.run(immediate(log, 'save'));
        await Promise.resolve();
        // Queued after the save, but urgent: it goes first once the connection frees.
        const urgent = queue.run(immediate(log, 'hydrate'), true);
        running.release();
        await Promise.all([started, background, urgent]);
        expect(log).toEqual(['start running', 'end running', 'hydrate', 'save']);
    });

    it('keeps arrival order within each class', async () => {
        const log: string[] = [];
        const queue = new StatementQueue();
        const first = makeJob(log, 'blocker');
        const started = queue.run(first.work);
        const a = queue.run(immediate(log, 'a'));
        const b = queue.run(immediate(log, 'b'));
        const u1 = queue.run(immediate(log, 'u1'), true);
        const u2 = queue.run(immediate(log, 'u2'), true);
        first.release();
        await Promise.all([started, a, b, u1, u2]);
        expect(log.slice(2)).toEqual(['u1', 'u2', 'a', 'b']);
    });

    it('keeps running after a job throws, and gives the error to its own caller', async () => {
        const log: string[] = [];
        const queue = new StatementQueue();
        const failing = queue.run(async () => { throw new Error('database is locked'); });
        const after = queue.run(immediate(log, 'after'));
        await expect(failing).rejects.toThrow('database is locked');
        await after;
        expect(log).toEqual(['after']);
    });

    it('stops pumping when there is nothing left, and starts again on the next job', async () => {
        const log: string[] = [];
        const queue = new StatementQueue();
        await queue.run(immediate(log, 'one'));
        expect(queue.waiting).toBe(0);
        await queue.run(immediate(log, 'two'));
        expect(log).toEqual(['one', 'two']);
    });
});
