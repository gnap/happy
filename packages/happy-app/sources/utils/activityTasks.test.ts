import { describe, expect, it } from 'vitest';
import { groupActivityTasks, type ActivityTask } from './activityTasks';

const task = (type: string, id = type): ActivityTask => ({ id, type, status: 'running', description: `${type} thing` });

describe('groupActivityTasks', () => {
    it('gives every type its own group', () => {
        // Counting a subagent and a background command as one number says how much is running
        // without saying what — and a subagent is the one you can talk to.
        const groups = groupActivityTasks([task('subagent'), task('shell'), task('shell', 's2')]);
        expect(groups.map((g) => [g.type, g.tasks.length])).toEqual([['subagent', 1], ['shell', 2]]);
    });

    it('keeps the drawing order fixed, whatever order the tasks arrive in', () => {
        const groups = groupActivityTasks([task('shell'), task('workflow'), task('monitor')]);
        expect(groups.map((g) => g.type)).toEqual(['monitor', 'shell', 'workflow']);
    });

    it('gives a type it has never been taught its own group rather than folding it away', () => {
        // The CLI learns kinds of background work on its own schedule; a count that omits one is
        // worse than a count that names it.
        const groups = groupActivityTasks([task('subagent'), task('something-new', 'n1'), task('something-new', 'n2')]);
        expect(groups.map((g) => [g.type, g.tasks.length])).toEqual([['subagent', 1], ['something-new', 2]]);
    });

    it('reports nothing for a session with no tasks', () => {
        expect(groupActivityTasks(null)).toEqual([]);
        expect(groupActivityTasks(undefined)).toEqual([]);
        expect(groupActivityTasks([])).toEqual([]);
    });
});
