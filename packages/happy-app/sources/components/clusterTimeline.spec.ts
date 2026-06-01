import { describe, it, expect, beforeEach } from 'vitest';
import {
    computeMessageClusters,
    TaskClusterMessage,
    ClusteredMessage,
} from './clusterTimeline';
import {
    Message,
    UserTextMessage,
    AgentTextMessage,
    ToolCallMessage,
    ModeSwitchMessage,
    ToolCall,
} from '@/sync/typesMessage';
import type { TaskItem } from './TaskListView';

// ---------------------------------------------------------------------------
// Test fixture builders
// ---------------------------------------------------------------------------

let _idCounter = 0;
function uid(prefix = 'msg'): string {
    return `${prefix}-${++_idCounter}`;
}

function resetIds(): void {
    _idCounter = 0;
}

function tc(
    name: string,
    createdAt: number,
    input: Record<string, unknown>,
    state: ToolCall['state'] = 'running',
    overrides: Partial<ToolCallMessage> = {},
): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: uid('tc'),
        localId: null,
        createdAt,
        tool: {
            name,
            state,
            input,
            createdAt,
            startedAt: null,
            completedAt: null,
            description: null,
        },
        children: [],
        meta: undefined,
        ...overrides,
    } as ToolCallMessage;
}

function ut(
    text: string,
    createdAt: number,
    localId: string | null = null,
): UserTextMessage {
    return {
        kind: 'user-text',
        id: uid('user'),
        localId,
        createdAt,
        text,
    };
}

function at(
    text: string,
    createdAt: number,
): AgentTextMessage {
    return {
        kind: 'agent-text',
        id: uid('agent'),
        localId: null,
        createdAt,
        text,
    };
}

function ae(createdAt: number): ModeSwitchMessage {
    return {
        kind: 'agent-event',
        id: uid('event'),
        createdAt,
        event: { type: 'message', message: 'Turn started' },
    };
}

// Convenience: TaskCreate tool-call
function taskCreate(
    subject: string,
    createdAt: number,
    description?: string,
): ToolCallMessage {
    return tc('TaskCreate', createdAt, {
        subject,
        description: description || subject,
        activeForm: '',
    });
}

// Convenience: TaskUpdate tool-call
function taskUpdate(
    taskId: string,
    status: string,
    createdAt: number,
): ToolCallMessage {
    return tc('TaskUpdate', createdAt, { taskId, status });
}

// Helper: find the timeline card in the result
function findTimeline(result: ClusteredMessage[]): TaskClusterMessage | undefined {
    return result.find(
        (m): m is TaskClusterMessage => m.kind === 'task-cluster',
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeMessageClusters', () => {
    beforeEach(() => resetIds());

    // -----------------------------------------------------------------------
    // Passthrough
    // -----------------------------------------------------------------------

    describe('passthrough', () => {
        it('returns empty array for empty input', () => {
            expect(computeMessageClusters([])).toEqual([]);
        });

        it('passes through user + agent messages unchanged when no tasks', () => {
            const msgs: Message[] = [
                ut('Hello', 1000),
                at('Hi there', 2000),
                ut('Help', 3000),
                at('Sure', 4000),
            ];
            const result = computeMessageClusters(msgs);
            expect(result).toHaveLength(4);
            expect(result).toEqual(msgs);
        });

        it('passes through non-task tool calls when no active tasks', () => {
            const msgs: Message[] = [
                ut('List files', 1000),
                tc('Bash', 2000, { command: 'ls' }),
                at('Here you go', 3000),
            ];
            const result = computeMessageClusters(msgs);
            expect(result).toHaveLength(3);
            expect(result.filter((r) => r.kind === 'tool-call')).toHaveLength(1);
        });
    });

    // -----------------------------------------------------------------------
    // Single task
    // -----------------------------------------------------------------------

    describe('single task creation', () => {
        it('creates a task-cluster message absorbing TaskCreate', () => {
            const msgs: Message[] = [
                ut('Do tasks', 1000),
                taskCreate('Fix the bug', 2000),
                at('Working...', 3000),
            ];
            const result = computeMessageClusters(msgs);
            // user-text + timeline + agent-text (no tool-call leaking)
            expect(result).toHaveLength(3);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            expect(tl!.tasks).toHaveLength(1);
            expect(tl!.tasks[0].content).toBe('Fix the bug');
            expect(tl!.tasks[0].status).toBe('pending');
            expect(tl!.collapsedCount).toBe(0);
        });

        it('replaces TaskCreate at the correct position', () => {
            // NOTE: with ascending timestamps the agent-text before the
            // TaskCreate is absorbed by backward extension (known issue).
            const msgs: Message[] = [
                ut('Question 1', 1000),
                at('Answer 1', 1500),
                taskCreate('Task A', 2000),
                ut('Question 2', 3000),
            ];
            const result = computeMessageClusters(msgs);
            // user-text(1000) + timeline + user-text(3000) = 3
            // agent-text(1500) is absorbed by backward extension
            expect(result).toHaveLength(3);
            // timeline should be between the two user-text messages
            expect(result[0].kind).toBe('user-text');
            expect(result[1].kind).toBe('task-cluster');
            expect(result[2].kind).toBe('user-text');
        });

        it('sets createdAt from the first TaskCreate', () => {
            const msgs: Message[] = [taskCreate('A', 5555)];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            expect(tl!.createdAt).toBe(5555);
        });
    });

    // -----------------------------------------------------------------------
    // Task lifecycle
    // -----------------------------------------------------------------------

    describe('task lifecycle', () => {
        it('updates status from pending to in_progress', () => {
            const msgs: Message[] = [
                taskCreate('Do thing', 1000),
                taskUpdate('1', 'in_progress', 2000),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            expect(tl!.tasks).toHaveLength(1);
            expect(tl!.tasks[0].status).toBe('in_progress');
        });

        it('updates status from in_progress to completed', () => {
            const msgs: Message[] = [
                taskCreate('Do thing', 1000),
                taskUpdate('1', 'in_progress', 2000),
                taskUpdate('1', 'completed', 3000),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            expect(tl!.tasks[0].status).toBe('completed');
        });

        it('allows direct pending → completed', () => {
            const msgs: Message[] = [
                taskCreate('Quick task', 1000),
                taskUpdate('1', 'completed', 1500),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            // Forward-only: completed > pending in order
            expect(tl!.tasks[0].status).toBe('completed');
        });

        it('does not revert completed back to in_progress', () => {
            const msgs: Message[] = [
                taskCreate('Done task', 1000),
                taskUpdate('1', 'completed', 2000),
                taskUpdate('1', 'in_progress', 3000), // stale, should be ignored
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            expect(tl!.tasks[0].status).toBe('completed');
        });
    });

    // -----------------------------------------------------------------------
    // Multi-task
    // -----------------------------------------------------------------------

    describe('multi-task timeline', () => {
        it('creates a single timeline card for multiple TaskCreates', () => {
            const msgs: Message[] = [
                taskCreate('Task A', 1000),
                taskCreate('Task B', 2000),
                taskCreate('Task C', 3000),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            expect(tl!.tasks).toHaveLength(3);
            expect(tl!.tasks[0].content).toBe('Task A');
            expect(tl!.tasks[1].content).toBe('Task B');
            expect(tl!.tasks[2].content).toBe('Task C');
        });

        it('updates each task independently by id', () => {
            const msgs: Message[] = [
                taskCreate('Task A', 1000),
                taskCreate('Task B', 1500),
                taskUpdate('2', 'in_progress', 2000), // position fallback: 2-1 = idx 1
                taskUpdate('1', 'completed', 2500), // position fallback: 1-1 = idx 0
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            expect(tl!.tasks[0].status).toBe('completed');
            expect(tl!.tasks[1].status).toBe('in_progress');
        });

        it('activeCount decrements correctly for multiple completions', () => {
            const msgs: Message[] = [
                taskCreate('Task A', 1000),
                taskCreate('Task B', 1100),
                ut('hi', 1200),
            ];
            // activeCount should be 2 — any tool-call with activeCount>0 is hidden
            const msgs2: Message[] = [
                ...msgs,
                tc('Bash', 1300, { command: 'ls' }),
                taskUpdate('1', 'completed', 1400),
                // activeCount should now be 1 — tool calls still hidden
                tc('Read', 1500, { file: 'f.txt' }),
                taskUpdate('2', 'completed', 1600),
                // activeCount should be 0 — tool calls visible again
                tc('Bash', 1700, { command: 'pwd' }),
            ];
            const result = computeMessageClusters(msgs2);
            // Should have: user-text + timeline + Bash(1700)
            // Bash(1300) and Read(1500) are absorbed
            expect(result.filter((r) => r.kind === 'tool-call')).toHaveLength(1);
            const tl = findTimeline(result)!;
            expect(tl.collapsedCount).toBe(2); // 2 tool calls absorbed during tasks
        });
    });

    // -----------------------------------------------------------------------
    // Tool call absorption
    // -----------------------------------------------------------------------

    describe('tool call absorption', () => {
        it('hides non-task tool calls when activeCount > 0', () => {
            const msgs: Message[] = [
                ut('Run tests', 1000),
                taskCreate('Testing', 2000),
                tc('Bash', 3000, { command: 'npm test' }),
                tc('Read', 4000, { file: 'result.txt' }),
                taskUpdate('1', 'completed', 5000),
            ];
            const result = computeMessageClusters(msgs);
            // No bare tool-call should leak out
            expect(result.filter((r) => r.kind === 'tool-call')).toHaveLength(0);
        });

        it('increments collapsedCount for each absorbed tool call', () => {
            const msgs: Message[] = [
                taskCreate('Build', 1000),
                tc('Bash', 2000, { command: 'make' }),
                tc('Bash', 3000, { command: 'make install' }),
                tc('Read', 4000, { file: 'log.txt' }),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            expect(tl!.collapsedCount).toBe(3);
        });

        it('shows non-task tool calls when activeCount is 0', () => {
            const msgs: Message[] = [
                taskCreate('Work', 1000),
                taskUpdate('1', 'completed', 1500),
                tc('Bash', 2000, { command: 'echo done' }),
            ];
            const result = computeMessageClusters(msgs);
            // The task was completed before the Bash ran — but in the current
            // implementation the check happens during Pass 1, so Bash after
            // the TaskUpdate that decremented activeCount should NOT be absorbed.
            // This depends on ordering: if TaskUpdate completes first, activeCount=0
            // before Bash is seen.
            const tl = findTimeline(result)!;
            expect(tl.tasks[0].status).toBe('completed');
            // Bash should be in the result (not absorbed)
            expect(result.filter((r) => r.kind === 'tool-call')).toHaveLength(1);
        });
    });

    // -----------------------------------------------------------------------
    // Backward extension
    // -----------------------------------------------------------------------

    describe('backward extension', () => {
        it('absorbs tool calls immediately before the first TaskCreate', () => {
            const msgs: Message[] = [
                ut('Do it', 1000),
                tc('Bash', 1500, { command: 'git status' }),
                taskCreate('Fix stuff', 2000),
            ];
            const result = computeMessageClusters(msgs);
            // Only user-text + timeline — Bash is absorbed (preCount)
            expect(result).toHaveLength(2);
            const tl = findTimeline(result)!;
            expect(tl.collapsedCount).toBe(1); // 1 pre-TaskCreate tool call
        });

        it('absorbs multiple tool calls before first TaskCreate', () => {
            const msgs: Message[] = [
                tc('Bash', 1000, { command: 'ls' }),
                tc('Read', 1100, { file: 'code.ts' }),
                taskCreate('Task', 1200),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result)!;
            expect(tl.collapsedCount).toBe(2);
            expect(result.filter((r) => r.kind === 'tool-call')).toHaveLength(0);
        });

        it('stops absorbing at a user-text boundary', () => {
            const msgs: Message[] = [
                ut('First message', 500),
                tc('Bash', 600, { command: 'old' }),
                ut('New turn', 1000), // boundary — absorption stops here
                tc('Bash', 1500, { command: 'new' }),
                taskCreate('Work', 2000),
            ];
            const result = computeMessageClusters(msgs);
            // user-text(500) stays, tool-call(600) stays (before the user boundary),
            // user-text(1000) stays, timeline absorbs Bash(1500) + TaskCreate(2000)
            const msgsBeforeTimeline = result.filter(
                (r) => r.kind === 'tool-call',
            );
            // Only the tool at 600 should remain visible
            expect(msgsBeforeTimeline).toHaveLength(1);
        });

        it('also absorbs agent-text and agent-event pre-TaskCreate', () => {
            const msgs: Message[] = [
                at('Thinking...', 900),
                ae(950),
                tc('Bash', 1000, { command: 'ls' }),
                taskCreate('Task', 1100),
            ];
            const result = computeMessageClusters(msgs);
            // Everything absorbed into timeline
            expect(result).toHaveLength(1);
            const tl = findTimeline(result)!;
            expect(tl.collapsedCount).toBe(1); // only the tool-call counts
        });
    });

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    describe('edge cases', () => {
        it('handles TaskUpdate with unrecognized taskId gracefully', () => {
            const msgs: Message[] = [
                taskCreate('Only task', 1000),
                taskUpdate('999', 'completed', 2000), // no match
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            // The unrecognized update should not affect the existing task
            expect(tl!.tasks[0].status).toBe('pending');
        });

        it('uses numeric-position fallback when direct id fails', () => {
            const msgs: Message[] = [
                taskCreate('First', 1000),
                taskCreate('Second', 1100),
                taskUpdate('2', 'completed', 1200), // id matches? 2 !== taskItems[1].id
            ];
            // taskItems[1].id is from description — if description = "Second", id = "Second"
            // parse "2" → 1 → maps to idx 1 → "Second" gets completed
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result)!;
            expect(tl.tasks[1].status).toBe('completed');
            expect(tl.tasks[0].status).toBe('pending');
        });

        it('handles all messages absorbed edge case', () => {
            // If all messages are absorbed (e.g., backward extension eats
            // everything) the edge-case fallback should still insert timeline.
            const msgs: Message[] = [
                tc('Bash', 900, { command: 'x' }),
                taskCreate('Work', 1000),
            ];
            const result = computeMessageClusters(msgs);
            expect(result).toHaveLength(1);
            expect(result[0].kind).toBe('task-cluster');
        });

        it('handles TaskCreate with no subject (uses description fallback)', () => {
            const msgs: Message[] = [
                tc('TaskCreate', 1000, {
                    description: 'Implicit desc',
                    activeForm: '',
                }),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result)!;
            expect(tl.tasks[0].content).toBe('Implicit desc');
        });

        it('handles TaskCreate with only activeForm', () => {
            const msgs: Message[] = [
                tc('TaskCreate', 1000, {
                    activeForm: 'Running tests...',
                }),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result)!;
            expect(tl.tasks[0].content).toBe('Running tests...');
        });

        it('stale TaskCreate before firstTaskTime is absorbed but hidden', () => {
            // A TaskUpdate with createdAt < firstTaskTime is absorbed without
            // updating any task state.
            const msgs: Message[] = [
                taskCreate('Main', 5000),
                taskUpdate('1', 'completed', 1000), // before firstTaskTime=5000
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result)!;
            // The stale update is absorbed but should NOT mark the task as completed
            expect(tl.tasks[0].status).toBe('pending');
        });
    });
});
