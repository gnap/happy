import { describe, expect, it } from 'vitest';
import { activityTaskText, groupActivityTasks, type ActivityTask } from './activityTasks';

const task = (type: string, id = type): ActivityTask => ({ id, type, status: 'running', description: `${type} thing` });

describe('groupActivityTasks', () => {
    it('folds the two names Claude Code gives the same task onto one group', () => {
        // `task_started` says local_bash, the snapshot at the end of the turn says shell — for the
        // same task_id. Two groups here would mean a count that moves without anything changing.
        const groups = groupActivityTasks([task('local_bash', 'a'), task('shell', 'b'), task('local_agent', 'c')]);
        expect(groups.map((g) => [g.type, g.tasks.length])).toEqual([['subagent', 1], ['shell', 2]]);
    });

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

describe('activityTaskText', () => {
    const base = { id: 't1', type: 'shell', status: 'running', description: '' };

    it('shows the name Claude Code gave the task, with the command underneath', () => {
        expect(activityTaskText({ ...base, description: 'Sleep 45 seconds', command: 'sleep 45' }))
            .toEqual({ title: 'Sleep 45 seconds', detail: 'sleep 45' });
    });

    it('marks a line that is a command as one instead of pretending it is a name', () => {
        // What Claude Code reports when the model gave the tool no description of its own: there is
        // no name to be had, so the line says what it is.
        expect(activityTaskText({ ...base, description: 'sleep 45', command: 'sleep 45' }))
            .toEqual({ title: '$ sleep 45' });
        expect(activityTaskText({ ...base, description: '', command: 'bun test' }))
            .toEqual({ title: '$ bun test' });
    });

    it('falls back to the kind only when there is nothing to run either', () => {
        expect(activityTaskText({ ...base, description: '   ' })).toEqual({ title: 'shell' });
        expect(activityTaskText({ id: 't9', type: 'local_bash', status: 'running', description: '' }))
            .toEqual({ title: 'shell' });
    });

    it('has a detail for the kinds that have no command', () => {
        expect(activityTaskText({ ...base, type: 'subagent', description: 'Audit the parser', agentType: 'code-reviewer' }))
            .toEqual({ title: 'Audit the parser', detail: 'code-reviewer' });
        expect(activityTaskText({ ...base, type: 'monitor', description: 'Watch CI', server: 'github', tool: 'checks' }))
            .toEqual({ title: 'Watch CI', detail: 'github · checks' });
    });
});
