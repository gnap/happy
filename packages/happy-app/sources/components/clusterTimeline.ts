import { Message } from '@/sync/typesMessage';
import type { TaskItem } from './TaskListView';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskClusterMessage {
    id: string;
    kind: 'task-cluster';
    tasks: TaskItem[];
    collapsedCount: number;
    createdAt: number;
}

export type ClusteredMessage = Message | TaskClusterMessage;

export interface ClusterOptions {
    /** Tasks from session state (reducer's latestTasks). Falls back to parsing from messages. */
    tasks?: Array<{ id: string; content: string; status: string }>;
    /** Maps global taskId → task content for matching across segments. */
    taskContentMap?: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// computeMessageClusters
// ---------------------------------------------------------------------------

/**
 * Groups TaskCreate/TaskUpdate tool-call messages into timeline cards.
 *
 * Splits at user-text boundaries into segments, then detects task clusters
 * within each segment. A new cluster starts when activeCount reaches 0 and a
 * fresh TaskCreate appears.
 */
export function computeMessageClusters(
    messages: readonly Message[],
    options?: ClusterOptions,
): ClusteredMessage[] {
    // ---- Split into segments at user-text boundaries ----------------------
    const segments: { start: number; end: number }[] = [];
    let segStart = 0;
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].kind === 'user-text') {
            segments.push({ start: segStart, end: i });
            segStart = i;
        }
    }
    segments.push({ start: segStart, end: messages.length });

    // ---- Process each segment ---------------------------------------------
    const result: ClusteredMessage[] = [];
    for (const seg of segments) {
        const clustered = clusterSegment(
            messages.slice(seg.start, seg.end),
            seg.start,
            options,
        );
        for (const cm of clustered) result.push(cm);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Cluster within a single segment
// ---------------------------------------------------------------------------

interface ClusterSnap {
    taskItems: TaskItem[];
    firstIdx: number;
    firstCreatedAt: number;
    hideSet: Set<number>;
    preCount: number;
}

function clusterSegment(
    messages: readonly Message[],
    offset: number,
    options?: ClusterOptions,
): ClusteredMessage[] {
    if (messages.length === 0) return [];

    const clusterSnaps: ClusterSnap[] = [];
    const allHidden = new Set<number>();

    // State for the current cluster
    let taskItems: TaskItem[] = [];
    let activeCount = 0;
    let currentTaskIdx = -1;
    const completedOnce = new Map<string, boolean>();
    const tidToIdx = new Map<string, number>();
    let hideSet = new Set<number>();
    let firstTaskIdx = -1;
    let firstTaskCreatedAt = 0;
    const pendingUpdates: { tid: string; status: string }[] = [];
    let clusterStart = 0;
    let taskIdBase = 1;
    let hasExplicitBase = false;

    // Derive taskIdBase from session tasks if available
    const sessionTasks = options?.tasks;
    if (sessionTasks && sessionTasks.length > 0) {
        const nums = sessionTasks
            .map((t) => parseInt(t.id, 10))
            .filter((n) => !isNaN(n));
        if (nums.length > 0) {
            taskIdBase = Math.min(...nums);
            hasExplicitBase = true;
        }
    }

    // Derive taskIdBase from message TaskUpdate taskIds
    const recalcBase = (fromIdx: number) => {
        if (hasExplicitBase) return;
        let minTid = Infinity;
        let seenTc = false;
        for (let i = fromIdx; i < messages.length; i++) {
            const m = messages[i] as any;
            if (m.kind === 'tool-call' && m.tool?.name === 'TaskCreate') seenTc = true;
            if (seenTc && m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate') {
                const n = parseInt(String(m.tool?.input?.taskId || m.tool?.input?.id), 10);
                if (!isNaN(n) && n < minTid) minTid = n;
            }
        }
        if (isFinite(minTid)) taskIdBase = minTid;
        else taskIdBase = 1;
    };
    recalcBase(0);

    // ---- TaskUpdate matching ----------------------------------------------
    const resolveTaskIndex = (tid: string): number => {
        // Direct id match
        let mi = taskItems.findIndex((t) => t.id === tid);
        if (mi >= 0) return mi;

        // Content map lookup
        const content = options?.taskContentMap?.get(tid);
        if (content) {
            mi = taskItems.findIndex(
                (t) => t.content === content || t.id === content,
            );
            if (mi >= 0) {
                const n = parseInt(tid, 10);
                if (!isNaN(n)) taskIdBase = n - mi;
                tidToIdx.set(tid, mi);
                return mi;
            }
            // Fuzzy: partial match
            mi = taskItems.findIndex(
                (t) =>
                    t.content.includes(content) || content.includes(t.content),
            );
            if (mi >= 0) {
                const n = parseInt(tid, 10);
                if (!isNaN(n)) taskIdBase = n - mi;
                tidToIdx.set(tid, mi);
                return mi;
            }
        }

        // tidToIdx map
        if (tidToIdx.has(tid)) return tidToIdx.get(tid)!;

        // Numeric fallback
        const num = parseInt(tid, 10);
        if (!isNaN(num)) {
            // Direct position
            let pi = num - 1;
            if (pi >= 0 && pi < taskItems.length) {
                tidToIdx.set(tid, pi);
                return pi;
            }
            // Offset correction
            pi = num - taskIdBase;
            if (pi >= 0 && pi < taskItems.length) {
                tidToIdx.set(tid, pi);
                return pi;
            }
        }

        return -1;
    };

    const applyTaskUpdate = (tid: string, status: string) => {
        const mi = resolveTaskIndex(tid);
        if (mi < 0 || mi >= taskItems.length) return;
        const order: Record<string, number> = {
            pending: 0,
            in_progress: 1,
            completed: 2,
        };
        const ns = status || taskItems[mi].status;
        if (
            (order[ns] ?? -1) > (order[taskItems[mi].status] ?? -1)
        ) {
            taskItems[mi] = {
                ...taskItems[mi],
                status: ns as TaskItem['status'],
            };
        }
        if (ns === 'completed' && !completedOnce.get(taskItems[mi].id)) {
            completedOnce.set(taskItems[mi].id, true);
            activeCount = Math.max(0, activeCount - 1);
        }
        currentTaskIdx = mi;
    };

    // ---- Helper: snapshot current cluster and reset -----------------------
    const snapshotCluster = (preCount: number) => {
        if (taskItems.length === 0) return;
        const snap = new Set<number>();
        for (const idx of hideSet) {
            if (idx >= clusterStart) snap.add(idx);
        }
        clusterSnaps.push({
            taskItems: taskItems.map((t) => ({ ...t })),
            firstIdx: firstTaskIdx,
            firstCreatedAt: firstTaskCreatedAt,
            hideSet: snap,
            preCount,
        });
    };

    const resetClusterState = (fromIdx: number) => {
        taskItems = [];
        activeCount = 0;
        currentTaskIdx = -1;
        completedOnce.clear();
        tidToIdx.clear();
        hideSet = new Set<number>();
        firstTaskIdx = -1;
        firstTaskCreatedAt = 0;
        pendingUpdates.length = 0;
        recalcBase(fromIdx);
    };

    // ---- Main loop --------------------------------------------------------
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i] as any;

        if (m.kind === 'tool-call' && m.tool?.name === 'TaskCreate') {
            // If activeCount is 0 and we already have tasks, this starts a
            // new cluster — snapshot the current one first.
            if (activeCount === 0 && taskItems.length > 0) {
                let pre = 0;
                if (firstTaskIdx > clusterStart) {
                    for (let j = firstTaskIdx - 1; j >= clusterStart; j--) {
                        if (messages[j].kind === 'tool-call') {
                            pre++;
                            allHidden.add(j + offset);
                        } else break;
                    }
                }
                snapshotCluster(pre);
                resetClusterState(i);
                clusterStart = i;
            }

            const input = m.tool?.input || {};
            const content =
                input.subject || input.description || input.activeForm || '';
            const descKey = input.description || '';
            const newIdx = taskItems.length;
            taskItems.push({
                id: descKey || String(newIdx + 1),
                content,
                status: 'pending',
                collapsedCount: 0,
            });
            activeCount++;
            currentTaskIdx = newIdx;
            if (firstTaskIdx < 0) {
                firstTaskIdx = i;
                firstTaskCreatedAt = m.createdAt;
            }
            hideSet.add(i);
            allHidden.add(i + offset);

            // Content map matching for global taskIds
            if (options?.taskContentMap) {
                for (const [tid, tc] of options.taskContentMap) {
                    if (
                        tc === content ||
                        tc === descKey ||
                        content.includes(tc) ||
                        tc.includes(content)
                    ) {
                        const n = parseInt(tid, 10);
                        if (!isNaN(n)) taskIdBase = n - newIdx;
                        tidToIdx.set(tid, newIdx);
                        break;
                    }
                }
            }

            // Replay pending (non-completed) pre-TaskCreate updates
            for (const pu of pendingUpdates) {
                if (pu.status !== 'completed') applyTaskUpdate(pu.tid, pu.status);
            }
            pendingUpdates.length = 0;
        } else if (
            m.kind === 'tool-call' &&
            m.tool?.name === 'TaskUpdate'
        ) {
            if (taskItems.length === 0) {
                // Pre-TaskCreate update — buffer it
                const input = m.tool?.input || {};
                const tid = String(input.taskId || input.id || '');
                const status = String(input.status || '');
                pendingUpdates.push({ tid, status });
            } else {
                const input = m.tool?.input || {};
                const tid = String(input.taskId || input.id || '');
                const status = String(input.status || '');
                applyTaskUpdate(tid, status);
            }
            hideSet.add(i);
            allHidden.add(i + offset);
        } else if (m.kind === 'tool-call' && activeCount > 0) {
            // Absorb non-task tool calls while tasks running
            if (currentTaskIdx >= 0 && currentTaskIdx < taskItems.length) {
                taskItems[currentTaskIdx].collapsedCount =
                    (taskItems[currentTaskIdx].collapsedCount ?? 0) + 1;
            }
            hideSet.add(i);
            allHidden.add(i + offset);
        }
    }

    // Final cluster snapshot
    {
        let pre = 0;
        if (firstTaskIdx > clusterStart) {
            for (let j = firstTaskIdx - 1; j >= clusterStart; j--) {
                if (messages[j].kind === 'tool-call') {
                    pre++;
                    allHidden.add(j + offset);
                } else break;
            }
        }
        snapshotCluster(pre);
    }

    // ---- Build output -----------------------------------------------------
    const result: ClusteredMessage[] = [];
    const insertionPoints = new Map<number, ClusterSnap>();
    for (const snap of clusterSnaps) {
        insertionPoints.set(snap.firstIdx, snap);
    }

    for (let i = 0; i < messages.length; i++) {
        const snap = insertionPoints.get(i);
        if (snap) {
            const collapsedToolCount =
                snap.taskItems.reduce(
                    (sum, t) => sum + (t.collapsedCount ?? 0),
                    0,
                ) + snap.preCount;
            result.push({
                id: 'task-timeline',
                kind: 'task-cluster',
                tasks: snap.taskItems,
                collapsedCount: collapsedToolCount,
                createdAt: snap.firstCreatedAt,
            });
        }
        if (!allHidden.has(i + offset)) {
            result.push(messages[i]);
        }
    }

    // Edge case: timeline not yet in result
    if (
        clusterSnaps.length > 0 &&
        !result.some(
            (r): r is TaskClusterMessage => r.kind === 'task-cluster',
        )
    ) {
        const snap = clusterSnaps[0];
        result.splice(0, 0, {
            id: 'task-timeline',
            kind: 'task-cluster',
            tasks: snap.taskItems,
            collapsedCount:
                snap.taskItems.reduce(
                    (sum, t) => sum + (t.collapsedCount ?? 0),
                    0,
                ) + snap.preCount,
            createdAt: snap.firstCreatedAt,
        });
    }

    return result;
}
