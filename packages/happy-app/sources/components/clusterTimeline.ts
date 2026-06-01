import { Message, ToolCallMessage } from '@/sync/typesMessage';
import type { TaskItem } from './TaskListView';

// ---------------------------------------------------------------------------
// Pseudo-message inserted at the first TaskCreate position to render the
// single timeline card that replaces the whole task cluster.
// ---------------------------------------------------------------------------

export interface TaskClusterMessage {
    id: string;
    kind: 'task-cluster';
    tasks: TaskItem[];
    collapsedCount: number;
    createdAt: number;
}

export type ClusteredMessage = Message | TaskClusterMessage;

// ---------------------------------------------------------------------------
// Pure function extracted from ChatList.tsx useMemo.
//
// Groups TaskCreate/TaskUpdate tool-call messages into a single timeline
// card (TaskClusterMessage). Non‑task tool calls are hidden while any task
// is still active (activeCount > 0). Messages immediately before the first
// TaskCreate in the same turn are also absorbed (backward extension).
//
// Known issues:
// - TaskUpdate taskIds are GLOBAL sequential; position‑based fallback may
//   match a TaskUpdate to the wrong task when taskIds don't align.
// - backward extension absorbs agent-text / agent-event messages as well as
//   tool calls (should arguably only absorb tool calls).
// - If a TaskUpdate arrives before ANY TaskCreate its status update is lost
//   (tidToIdx map has no entry yet).
// ---------------------------------------------------------------------------

export function computeMessageClusters(
    messages: readonly Message[],
): ClusteredMessage[] {
    // ---- Pass 1: collect task state + mark messages to hide -----------------
    const taskItems: TaskItem[] = [];
    let activeCount = 0;
    let currentTaskIdx = -1;
    const completedOnce = new Map<string, boolean>();
    const tidToIdx = new Map<string, number>();
    const hideSet = new Set<number>();
    let firstTaskIdx = -1;
    let firstTaskCreatedAt = 0;
    let firstTaskTime = 0;

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];

        if (m.kind === 'tool-call' && m.tool?.name === 'TaskCreate') {
            const input = m.tool?.input || {};
            const content = input.subject || input.description || input.activeForm || '';
            const descKey = input.description || '';
            taskItems.push({
                id: descKey || String(taskItems.length + 1),
                content,
                status: 'pending',
                collapsedCount: 0,
            });
            activeCount++;
            currentTaskIdx = taskItems.length - 1;
            if (firstTaskIdx < 0) {
                firstTaskIdx = i;
                firstTaskCreatedAt = m.createdAt;
            }
            if (!firstTaskTime) firstTaskTime = m.createdAt;
            hideSet.add(i);
        } else if (m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate') {
            // Stale TaskUpdate from before the first TaskCreate in this turn
            if (firstTaskTime && m.createdAt < firstTaskTime) {
                hideSet.add(i);
                continue;
            }
            const input = m.tool?.input || {};
            const tid = (input.taskId || input.id || '') as string;
            const status = (input.status as string) || '';
            let mi = taskItems.findIndex((t) => t.id === tid);
            // Position-based fallback
            if (mi < 0) {
                const pi = parseInt(tid, 10) - 1;
                if (pi >= 0 && pi < taskItems.length) mi = pi;
            }
            // Sequential in_progress fallback
            if (mi < 0 && status === 'in_progress') {
                mi = taskItems.findIndex((t) => t.status === 'pending');
                if (mi >= 0) tidToIdx.set(tid, mi);
            } else if (mi < 0 && status === 'completed') {
                const p = tidToIdx.get(tid);
                if (p !== undefined) mi = p;
            }
            if (mi >= 0) {
                const order: Record<string, number> = {
                    pending: 0,
                    in_progress: 1,
                    completed: 2,
                };
                const ns = status || taskItems[mi].status;
                if (
                    (order[ns] ?? -1) >
                    (order[taskItems[mi].status] ?? -1)
                ) {
                    taskItems[mi] = { ...taskItems[mi], status: ns as TaskItem['status'] };
                }
                if (ns === 'completed' && !completedOnce.get(taskItems[mi].id)) {
                    completedOnce.set(taskItems[mi].id, true);
                    activeCount = Math.max(0, activeCount - 1);
                }
                currentTaskIdx = mi;
            }
            hideSet.add(i);
        } else if (m.kind === 'tool-call' && activeCount > 0) {
            // Absorb non‑task tool calls while tasks are running
            if (currentTaskIdx >= 0 && currentTaskIdx < taskItems.length) {
                taskItems[currentTaskIdx].collapsedCount =
                    (taskItems[currentTaskIdx].collapsedCount ?? 0) + 1;
            }
            hideSet.add(i);
        }
    }

    // ---- Absorb tool calls before first TaskCreate in the same turn ---------
    let preCount = 0;
    if (firstTaskIdx >= 0) {
        for (let i = firstTaskIdx - 1; i >= 0; i--) {
            const m = messages[i];
            if (
                m.kind === 'tool-call' ||
                m.kind === 'agent-text' ||
                m.kind === 'agent-event'
            ) {
                hideSet.add(i);
                if (m.kind === 'tool-call') preCount++;
            } else {
                break;
            }
        }
    }

    // ---- Pass 2: build result, inserting timeline card at firstTaskIdx -----
    const result: ClusteredMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
        if (hideSet.has(i)) {
            if (i === firstTaskIdx && taskItems.length > 0) {
                const collapsedToolCount =
                    taskItems.reduce(
                        (sum, t) => sum + (t.collapsedCount ?? 0),
                        0,
                    ) + preCount;
                result.push({
                    id: 'task-timeline',
                    kind: 'task-cluster',
                    tasks: taskItems,
                    collapsedCount: collapsedToolCount,
                    createdAt: firstTaskCreatedAt,
                });
            }
            continue;
        }
        result.push(messages[i]);
    }

    // Edge case: all messages absorbed but timeline not yet in result
    if (
        firstTaskIdx >= 0 &&
        taskItems.length > 0 &&
        !result.some((r): r is TaskClusterMessage => r.kind === 'task-cluster')
    ) {
        result.splice(0, 0, {
            id: 'task-timeline',
            kind: 'task-cluster',
            tasks: taskItems,
            collapsedCount:
                taskItems.reduce(
                    (sum, t) => sum + (t.collapsedCount ?? 0),
                    0,
                ) + preCount,
            createdAt: firstTaskCreatedAt,
        });
    }

    return result;
}
