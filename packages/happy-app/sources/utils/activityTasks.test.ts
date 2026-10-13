import { describe, expect, it } from 'vitest';
import { activityKindOf, groupActivityTasks, type ActivityTask } from './activityTasks';

const task = (type: string, id = type): ActivityTask => ({ id, type, status: 'running', description: `${type} thing` });

describe('activityKindOf', () => {
    it('separates the kinds the CLI names', () => {
        expect(activityKindOf(task('subagent'))).toBe('agents');
        expect(activityKindOf(task('monitor'))).toBe('monitors');
        expect(activityKindOf(task('shell'))).toBe('tasks');
        expect(activityKindOf(task('workflow'))).toBe('tasks');
    });

    it('counts a kind it has never been taught as a task, rather than dropping it', () => {
        // The CLI learns new kinds of background work on its own schedule; a count that silently
        // omits one is worse than a count that files it under the generic kind.
        expect(activityKindOf(task('something-new'))).toBe('tasks');
    });
});

describe('groupActivityTasks', () => {
    it('groups by kind and keeps every kind present', () => {
        const grouped = groupActivityTasks([task('subagent'), task('monitor', 'm1'), task('monitor', 'm2'), task('shell')]);
        expect(grouped.agents.map((t) => t.id)).toEqual(['subagent']);
        expect(grouped.monitors.map((t) => t.id)).toEqual(['m1', 'm2']);
        expect(grouped.tasks.map((t) => t.id)).toEqual(['shell']);
    });

    it('returns empty groups for a session with no tasks', () => {
        expect(groupActivityTasks(null)).toEqual({ agents: [], monitors: [], tasks: [] });
        expect(groupActivityTasks(undefined)).toEqual({ agents: [], monitors: [], tasks: [] });
    });
});
