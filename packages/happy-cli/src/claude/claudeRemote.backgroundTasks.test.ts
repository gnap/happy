/**
 * The rule that decides what a background task is *called*.
 *
 * Worth its own test because the two sources disagree in a way that is easy to miss: the snapshot
 * knows the command, the `task_started` frame knows the name, and the snapshot's name is the command
 * whenever the model gave the tool no description of its own.
 */

import { describe, expect, it } from 'vitest';
import { withBestTitle, type BackgroundTaskForApp } from './claudeRemote';

const task = (patch: Partial<BackgroundTaskForApp>): BackgroundTaskForApp => ({
    id: 't1',
    type: 'shell',
    status: 'running',
    description: '',
    ...patch,
});

describe('withBestTitle', () => {
    it('keeps a name the snapshot only repeats the command of', () => {
        expect(withBestTitle(
            task({ description: 'Sleep 45 seconds' }),
            task({ description: 'sleep 45', command: 'sleep 45' }),
        )).toMatchObject({ description: 'Sleep 45 seconds', command: 'sleep 45' });
    });

    it('keeps a name the snapshot has none of', () => {
        expect(withBestTitle(task({ description: 'Sleep 45 seconds' }), task({ description: '  ', command: 'sleep 45' })))
            .toMatchObject({ description: 'Sleep 45 seconds' });
    });

    it('takes a name the snapshot has, even when a stale one is known', () => {
        expect(withBestTitle(
            task({ description: 'sleep 45', command: 'sleep 45' }),
            task({ description: 'Sleep 45 seconds', command: 'sleep 45' }),
        )).toMatchObject({ description: 'Sleep 45 seconds' });
    });

    it('takes the snapshot as it comes for a task seen for the first time', () => {
        const only = task({ description: 'sleep 45', command: 'sleep 45' });
        expect(withBestTitle(undefined, only)).toBe(only);
        expect(withBestTitle(task({ description: '' }), only)).toBe(only);
    });
});
