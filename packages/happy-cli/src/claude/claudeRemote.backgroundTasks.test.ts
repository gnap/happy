/**
 * The rule that decides what a background task is *called*.
 *
 * Worth its own test because the two sources disagree in a way that is easy to miss: the snapshot
 * knows the command, the `task_started` frame knows the name, and the snapshot's name is the command
 * whenever the model gave the tool no description of its own.
 */

import { describe, expect, it } from 'vitest';
import { mergeTask, normalizeTaskType, taskTypeOf, toolTimeoutMs, type BackgroundTaskForApp } from './claudeRemote';

const task = (patch: Partial<BackgroundTaskForApp>): BackgroundTaskForApp => ({
    id: 't1',
    type: 'shell',
    status: 'running',
    description: '',
    ...patch,
});

describe('mergeTask', () => {
    it('keeps a name the snapshot only repeats the command of', () => {
        expect(mergeTask(
            task({ description: 'Sleep 45 seconds' }),
            task({ description: 'sleep 45', command: 'sleep 45' }),
        )).toMatchObject({ description: 'Sleep 45 seconds', command: 'sleep 45' });
    });

    it('keeps a name the snapshot has none of', () => {
        expect(mergeTask(task({ description: 'Sleep 45 seconds' }), task({ description: '  ', command: 'sleep 45' })))
            .toMatchObject({ description: 'Sleep 45 seconds' });
    });

    it('takes a name the snapshot has, even when a stale one is known', () => {
        expect(mergeTask(
            task({ description: 'sleep 45', command: 'sleep 45' }),
            task({ description: 'Sleep 45 seconds', command: 'sleep 45' }),
        )).toMatchObject({ description: 'Sleep 45 seconds' });
    });

    it('takes the snapshot as it comes for a task seen for the first time', () => {
        const only = task({ description: 'sleep 45', command: 'sleep 45' });
        expect(mergeTask(undefined, only)).toBe(only);
        expect(mergeTask(task({ description: '' }), only)).toBe(only);
    });
});

describe('the vocabulary a task is named in', () => {
    it('folds the stream name and the snapshot name of one task together', () => {
        // Same task_id, two words: a task must not change kind (or count twice) when a turn ends.
        expect(normalizeTaskType('local_bash')).toBe('shell');
        expect(normalizeTaskType('local_agent')).toBe('subagent');
        expect(normalizeTaskType('shell')).toBe('shell');
        expect(normalizeTaskType('monitor')).toBe('monitor');
    });

    it('believes the tool over the reported name, because the reported name is wrong for a monitor', () => {
        // A Monitor task is reported as local_bash / shell — the same words as a background command.
        expect(taskTypeOf('Monitor', 'local_bash')).toBe('monitor');
        expect(taskTypeOf('Bash', 'local_bash')).toBe('shell');
        expect(taskTypeOf('Agent', 'local_agent')).toBe('subagent');
        expect(taskTypeOf(undefined, 'local_agent')).toBe('subagent');
    });

    it('keeps the precise kind when a coarse snapshot arrives for it', () => {
        // What a Monitor task looks like: precise from the tool, then "shell" from the snapshot.
        const merged = mergeTask(
            task({ type: 'monitor', description: 'Watch the build log' }),
            task({ type: 'shell', description: 'Watch the build log', command: 'tail -f build.log' }),
        );
        expect(merged).toMatchObject({ type: 'monitor', description: 'Watch the build log', command: 'tail -f build.log' });
    });
});

describe('toolTimeoutMs', () => {
    it('reads the timeout only where a tool declares one', () => {
        expect(toolTimeoutMs('Monitor', { timeout_ms: 60_000 })).toBe(60_000);
        // A persistent watch has no deadline at all.
        expect(toolTimeoutMs('Monitor', { timeout_ms: 60_000, persistent: true })).toBeNull();
        expect(toolTimeoutMs('Bash', { command: 'sleep 5', timeout: 5_000 })).toBe(5_000);
        // A subagent runs until it is done; there is nothing to count down to.
        expect(toolTimeoutMs('Agent', { prompt: 'x' })).toBeNull();
        expect(toolTimeoutMs('Bash', { command: 'ls' })).toBeNull();
        expect(toolTimeoutMs('Monitor', null)).toBeNull();
    });
});

describe('mergeTask deadlines', () => {
    it('keeps the deadline the snapshot cannot know', () => {
        // The snapshot decides what is still running; the deadline came from the tool call, which
        // only the incremental set saw.
        const merged = mergeTask(
            task({ type: 'monitor', deadlineAt: 1_700_000_000_000, startedAt: 1_699_999_000_000 }),
            task({ type: 'monitor' }),
        );
        expect(merged.deadlineAt).toBe(1_700_000_000_000);
        expect(merged.startedAt).toBe(1_699_999_000_000);
    });

    it('prefers a deadline the incoming task carries, when it has one', () => {
        const merged = mergeTask(task({ deadlineAt: 1 }), task({ deadlineAt: 2 }));
        expect(merged.deadlineAt).toBe(2);
    });
});
