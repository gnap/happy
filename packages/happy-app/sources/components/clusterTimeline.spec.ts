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
            // agent-text is NOT absorbed by backward extension (only tool-calls are)
            const msgs: Message[] = [
                ut('Question 1', 1000),
                at('Answer 1', 1500),
                taskCreate('Task A', 2000),
                ut('Question 2', 3000),
            ];
            const result = computeMessageClusters(msgs);
            // user-text(1000) + agent-text(1500) + timeline + user-text(3000) = 4
            expect(result).toHaveLength(4);
            expect(result[0].kind).toBe('user-text');
            expect(result[1].kind).toBe('agent-text');
            expect(result[2].kind).toBe('task-cluster');
            expect(result[3].kind).toBe('user-text');
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
            // Real session: user-text starts the turn, then tasks + updates in same segment
            const msgs: Message[] = [
                ut('do two things', 500),
                taskCreate('Task A', 1000),
                taskCreate('Task B', 1100),
            ];
            const msgs2: Message[] = [
                ...msgs,
                tc('Bash', 1300, { command: 'ls' }),
                taskUpdate('1', 'completed', 1400),
                tc('Read', 1500, { file: 'f.txt' }),
                taskUpdate('2', 'completed', 1600),
                tc('Bash', 1700, { command: 'pwd' }),
            ];
            const result = computeMessageClusters(msgs2);
            // user-text + timeline + Bash(1700)
            // Bash(1300) and Read(1500) absorbed
            expect(result.filter((r) => r.kind === 'tool-call')).toHaveLength(1);
            const tl = findTimeline(result)!;
            expect(tl.collapsedCount).toBe(2);
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

        it('absorbs only tool-calls pre-TaskCreate, not agent-text/agent-event', () => {
            // agent-text and agent-event are NOT absorbed (Fix 5.2)
            const msgs: Message[] = [
                at('Thinking...', 900),
                ae(950),
                tc('Bash', 1000, { command: 'ls' }),
                taskCreate('Task', 1100),
            ];
            const result = computeMessageClusters(msgs);
            // agent-text + agent-event + timeline = 3
            expect(result).toHaveLength(3);
            expect(result[0].kind).toBe('agent-text');
            expect(result[1].kind).toBe('agent-event');
            const tl = findTimeline(result)!;
            expect(tl.collapsedCount).toBe(1); // only the Bash tool-call absorbed
        });
    });

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    describe('edge cases', () => {
        it('maps any taskId to the only task in a single-task cluster', () => {
            // With the per-cluster heuristic, the first TaskUpdate's taskId
            // maps to index 0 (assumes it targets the only task)
            const msgs: Message[] = [
                taskCreate('Only task', 1000),
                taskUpdate('999', 'completed', 2000),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result);
            expect(tl).toBeDefined();
            expect(tl!.tasks[0].status).toBe('completed');
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

        it('ignores completed pre-TaskCreate updates (cross-turn noise)', () => {
            // Pre-TaskCreate "completed" updates are from other turns;
            // they should NOT prematurely finish current-turn tasks.
            const msgs: Message[] = [
                taskUpdate('1', 'completed', 1000),
                taskCreate('Main', 5000),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result)!;
            expect(tl.tasks[0].status).toBe('pending');
        });

        it('replays non-completed pre-TaskCreate updates', () => {
            const msgs: Message[] = [
                taskUpdate('1', 'in_progress', 1000),
                taskCreate('Main', 5000),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result)!;
            expect(tl.tasks[0].status).toBe('in_progress');
        });
    });

    // -------------------------------------------------------------------
    // Multi-turn (segment-based clustering)
    // -------------------------------------------------------------------

    describe('multi-turn segments', () => {
        it('creates separate timeline cards per user-turn', () => {
            const msgs: Message[] = [
                ut('Turn 1: fix bug', 1000),
                taskCreate('Fix login', 2000),
                taskUpdate('1', 'completed', 3000),
                at('Done', 3500),
                ut('Turn 2: add feature', 4000),
                taskCreate('Add export', 5000),
                taskUpdate('2', 'completed', 6000),
                at('Done', 6500),
            ];
            const result = computeMessageClusters(msgs);
            const timelines = result.filter((r) => r.kind === 'task-cluster');
            expect(timelines).toHaveLength(2);
        });

        it('each turn cluster only contains its own tasks', () => {
            const msgs: Message[] = [
                ut('First', 1000),
                taskCreate('Task A', 2000),
                at('ok', 3000),
                ut('Second', 4000),
                taskCreate('Task B', 5000),
                at('ok', 6000),
            ];
            const result = computeMessageClusters(msgs);
            const timelines = result.filter(
                (r): r is TaskClusterMessage => r.kind === 'task-cluster',
            );
            expect(timelines).toHaveLength(2);
            expect(timelines[0].tasks).toHaveLength(1);
            expect(timelines[0].tasks[0].content).toBe('Task A');
            expect(timelines[1].tasks).toHaveLength(1);
            expect(timelines[1].tasks[0].content).toBe('Task B');
        });

        it('absorbs tool calls within each turn independently', () => {
            const msgs: Message[] = [
                ut('Turn 1', 1000),
                taskCreate('A', 2000),
                tc('Bash', 2500, { command: 'ls' }),
                taskUpdate('1', 'completed', 3000),
                ut('Turn 2', 4000),
                taskCreate('B', 5000),
                tc('Read', 5500, { file: 'x.ts' }),
                taskUpdate('2', 'completed', 6000),
            ];
            const result = computeMessageClusters(msgs);
            const timelines = result.filter(
                (r): r is TaskClusterMessage => r.kind === 'task-cluster',
            );
            expect(timelines).toHaveLength(2);
            expect(timelines[0].collapsedCount).toBe(1); // Bash absorbed
            expect(timelines[1].collapsedCount).toBe(1); // Read absorbed
        });
        it('splits into multiple clusters when activeCount reaches 0', () => {
            // Simulates real session: no user-text, two batches of tasks
            // Use taskContentMap to bridge global taskId → content matching
            const msgs: Message[] = [
                // Batch 1: pre-updates then 2 TaskCreates
                tc('TaskUpdate', 500, { taskId: 1, status: 'completed' } as any),
                tc('Bash', 600, { command: 'setup' }),
                taskCreate('Batch1-A', 1000, 'Batch1-A'),
                taskCreate('Batch1-B', 1100, 'Batch1-B'),
                taskUpdate('1', 'completed', 1200),
                taskUpdate('2', 'completed', 1300),
                // Batch 2: activeCount=0, new TaskCreates → new cluster
                taskCreate('Batch2-A', 2000, 'Batch2-A'),
                taskCreate('Batch2-B', 2100, 'Batch2-B'),
                taskUpdate('3', 'completed', 2200),
                taskUpdate('4', 'completed', 2300),
            ];
            const opts = { taskContentMap: new Map([
                ['1', 'Batch1-A'], ['2', 'Batch1-B'],
                ['3', 'Batch2-A'], ['4', 'Batch2-B'],
            ]) };
            const result = computeMessageClusters(msgs, opts);
            const cards = result.filter((r): r is TaskClusterMessage => r.kind === 'task-cluster');
            expect(cards.length).toBe(2);
            expect(cards[0].tasks.map(t => t.content)).toEqual(['Batch1-A', 'Batch1-B']);
            expect(cards[1].tasks.map(t => t.content)).toEqual(['Batch2-A', 'Batch2-B']);
        });

        it('matches global taskIds via offset correction', () => {
            // Simulates session with 44 prior tasks, current turn starts at #45
            const msgs: Message[] = [
                taskCreate('Task A', 1000, 'Task A'),
                taskCreate('Task B', 1100, 'Task B'),
                taskUpdate('45', 'completed', 1200), // global taskId, not "1"
                taskUpdate('46', 'completed', 1300),
                // activeCount=0, new TaskCreate → new cluster
                taskCreate('Task C', 2000, 'Task C'),
                taskUpdate('47', 'completed', 2100),
            ];
            const opts = { taskContentMap: new Map([
                ['45', 'Task A'], ['46', 'Task B'], ['47', 'Task C'],
            ]) };
            const result = computeMessageClusters(msgs, opts);
            const cards = result.filter((r): r is TaskClusterMessage => r.kind === 'task-cluster');
            expect(cards.length).toBe(2);
            expect(cards[0].tasks[0].status).toBe('completed');
            expect(cards[1].tasks[0].status).toBe('completed');
        });

        it('matches by fuzzy content when subject differs from result text', () => {
            // Real session: TaskCreate input.subject may differ from result text
            const msgs: Message[] = [
                taskCreate('Investigate login bug', 1000, 'Investigate login bug'),
                taskCreate('Fix the issue', 1100, 'Fix the issue'),
                taskUpdate('5', 'completed', 1200),
                taskUpdate('6', 'completed', 1300),
                // New batch: activeCount=0, should start new cluster
                taskCreate('Add dark mode toggle', 2000, 'Add dark mode'),
                taskUpdate('7', 'completed', 2100),
            ];
            // Content map simulates session.tasks with global taskIds
            const opts = { taskContentMap: new Map([
                ['5', 'Investigate login bug'], // exact match
                ['6', 'Fix the issue'],          // exact match
                ['7', 'Add dark mode'],          // DIFFERENT from input.subject!
            ]) };
            const result = computeMessageClusters(msgs, opts);
            const cards = result.filter((r): r is TaskClusterMessage => r.kind === 'task-cluster');
            expect(cards.length).toBe(2);
            expect(cards[0].tasks[0].status).toBe('completed'); // matched by exact
            expect(cards[0].tasks[1].status).toBe('completed'); // matched by exact
            expect(cards[1].tasks[0].status).toBe('completed'); // matched by FUZZY
        });

        it('splits clusters with 8 zero-crossings and global taskIds (real session sim)', () => {
            // Simulate the real session: taskIds 54..79 (26 tasks), 8 zero-crossings
            // 3 tasks per batch, each batch completes before the next
            const msgs: any[] = [];
            const makeTC = (subj: string, time: number) =>
                tc('TaskCreate', time, { subject: subj, description: subj, activeForm: '' });
            const makeTU = (tid: number, status: string, time: number) =>
                tc('TaskUpdate', time, { taskId: tid, status } as any);

            // Batch 1: tasks 54,55,56
            msgs.push(makeTC('A1', 1000));
            msgs.push(makeTC('A2', 1100));
            msgs.push(makeTC('A3', 1200));
            msgs.push(makeTU(54, 'completed', 1300));
            msgs.push(makeTU(55, 'completed', 1400));
            msgs.push(makeTU(56, 'completed', 1500));
            // Batch 2: tasks 57,58 (zero #1, should trigger new cluster)
            msgs.push(makeTC('B1', 2000));
            msgs.push(makeTC('B2', 2100));
            msgs.push(makeTU(57, 'completed', 2200));
            msgs.push(makeTU(58, 'completed', 2300));
            // Batch 3: tasks 59,60,61 (zero #2)
            msgs.push(makeTC('C1', 3000));
            msgs.push(makeTC('C2', 3100));
            msgs.push(makeTC('C3', 3200));
            msgs.push(makeTU(59, 'completed', 3300));
            msgs.push(makeTU(60, 'completed', 3400));
            msgs.push(makeTU(61, 'completed', 3500));

            const result = computeMessageClusters(msgs);
            const cards = result.filter((r): r is TaskClusterMessage => r.kind === 'task-cluster');
            expect(cards.length).toBe(3);
            expect(cards[0].tasks.length).toBe(3);
            expect(cards[1].tasks.length).toBe(2);
            expect(cards[2].tasks.length).toBe(3);
        });

        it('matches global taskIds without taskContentMap', () => {
            // Real session: session.tasks is empty, taskIds are global (#48+)
            const msgs: Message[] = [
                taskCreate('Task A', 1000),
                taskCreate('Task B', 1100),
                tc('TaskUpdate', 1200, { taskId: 48, status: 'completed' } as any),
                tc('TaskUpdate', 1300, { taskId: 49, status: 'completed' } as any),
                // activeCount=0, new cluster
                taskCreate('Task C', 2000),
                tc('TaskUpdate', 2100, { taskId: 50, status: 'completed' } as any),
            ];
            const result = computeMessageClusters(msgs); // no taskContentMap!
            const cards = result.filter((r): r is TaskClusterMessage => r.kind === 'task-cluster');
            expect(cards.length).toBe(2);
            expect(cards[0].tasks[0].status).toBe('completed');
            expect(cards[0].tasks[1].status).toBe('completed');
            expect(cards[1].tasks[0].status).toBe('completed');
        });

        it('handles numeric taskId in TaskUpdate input', () => {
            // Real session protocol may send taskId as a number, not string
            const msgs: Message[] = [
                ut('do it', 500),
                taskCreate('Fix bug', 1000),
                tc('TaskUpdate', 2000, { taskId: 1, status: 'completed' } as any),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result)!;
            expect(tl.tasks[0].status).toBe('completed');
        });

        it('completes tasks in multi-batch without session.tasks (real session sim)', () => {
            // Simulating real session: 4 batches, global taskIds 33..46
            // No taskContentMap (session.tasks is empty in real sessions)
            const tk = (subj: string, time: number) =>
                taskCreate(subj, time, subj);
            const tu = (tid: number, status: string, time: number) =>
                tc('TaskUpdate', time, { taskId: tid, status } as any);

            const msgs: Message[] = [
                // Batch 1: tasks 33,34,35
                tk('A1', 1000), tk('A2', 1100), tk('A3', 1200),
                tu(33, 'completed', 1300),
                tu(34, 'completed', 1400),
                tu(35, 'completed', 1500),
                // Batch 2: tasks 36,37
                tk('B1', 2000), tk('B2', 2100),
                tu(36, 'completed', 2200),
                tu(37, 'completed', 2300),
                // Batch 3: tasks 38,39,40
                tk('C1', 3000), tk('C2', 3100), tk('C3', 3200),
                tu(38, 'in_progress', 3300),
                tu(39, 'completed', 3400),
                tu(40, 'completed', 3500),
            ];

            const result = computeMessageClusters(msgs);
            const cards = result.filter((r): r is TaskClusterMessage => r.kind === 'task-cluster');

            // Should be 3 clusters (batch 1, 2, 3)
            expect(cards.length).toBe(3);
            // Batch 1: all 3 completed
            expect(cards[0].tasks[0].status).toBe('completed');
            expect(cards[0].tasks[1].status).toBe('completed');
            expect(cards[0].tasks[2].status).toBe('completed');
            // Batch 2: both completed
            expect(cards[1].tasks[0].status).toBe('completed');
            expect(cards[1].tasks[1].status).toBe('completed');
            // Batch 3: first in_progress, others completed
            expect(cards[2].tasks[0].status).toBe('in_progress');
            expect(cards[2].tasks[1].status).toBe('completed');
            expect(cards[2].tasks[2].status).toBe('completed');
        });

        it('handles numeric id fallback in TaskUpdate input', () => {
            const msgs: Message[] = [
                ut('do it', 500),
                taskCreate('Fix bug', 1000),
                tc('TaskUpdate', 2000, { id: 1, status: 'in_progress' } as any),
            ];
            const result = computeMessageClusters(msgs);
            const tl = findTimeline(result)!;
            expect(tl.tasks[0].status).toBe('in_progress');
        });
    });

    // -------------------------------------------------------------------
    // User echo dedup
    // -------------------------------------------------------------------

    describe('user echo dedup', () => {
        it('deduplicates adjacent user-text with same text within 5s', () => {
            // Simulates optimistic + server echo arriving with different ids
            const msgs: Message[] = [
                ut('hello', 2000), // server echo (newer, different id)
                ut('hello', 1500), // optimistic (older, same text)
            ];
            const result = computeMessageClusters(msgs);
            expect(result.filter((r) => r.kind === 'user-text')).toHaveLength(1);
        });

        it('keeps user-text messages with different text', () => {
            const msgs: Message[] = [
                ut('message two', 2000),
                ut('message one', 1000),
            ];
            const result = computeMessageClusters(msgs);
            expect(result.filter((r) => r.kind === 'user-text')).toHaveLength(2);
        });

        it('keeps user-text messages with same text but >5s apart', () => {
            const msgs: Message[] = [
                ut('retry', 12000),
                ut('retry', 1000),
            ];
            const result = computeMessageClusters(msgs);
            expect(result.filter((r) => r.kind === 'user-text')).toHaveLength(2);
        });

        it('only deduplicates user-text, not task tool-calls', () => {
            // Two TaskCreates with same subject are NOT deduped (dedup only
            // applies to user-text echoes)
            const msgs: Message[] = [
                taskCreate('Fix bug', 2000),
                taskCreate('Fix bug', 1500),
            ];
            const result = computeMessageClusters(msgs);
            const tl = result.find((r) => r.kind === 'task-cluster') as any;
            expect(tl).toBeDefined();
            expect(tl.tasks).toHaveLength(2); // NOT deduped — two distinct tasks
        });
    });
});
