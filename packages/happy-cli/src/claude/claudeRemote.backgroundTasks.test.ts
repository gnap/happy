/**
 * The rule that decides what a background task is *called*.
 *
 * Worth its own test because the two sources disagree in a way that is easy to miss: the snapshot
 * knows the command, the `task_started` frame knows the name, and the snapshot's name is the command
 * whenever the model gave the tool no description of its own.
 */

import { describe, expect, it } from 'vitest';
import { mergeTask, normalizeTaskType, taskTypeOf, type BackgroundTaskForApp } from './claudeRemote';

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
