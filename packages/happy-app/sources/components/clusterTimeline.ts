import { Message } from '@/sync/typesMessage';
import type { TaskItem } from './TaskListView';

export interface TaskClusterMessage {
    id: string;
    kind: 'task-cluster';
    tasks: TaskItem[];
    collapsedCount: number;
    createdAt: number;
}

export type ClusteredMessage = Message | TaskClusterMessage;

export interface ClusterOptions {
    taskContentMap?: ReadonlyMap<string, string>;
}

// Split at user-text boundaries, then detect task clusters within each segment.
// A new cluster starts when activeCount reaches 0 and a fresh TaskCreate appears.

export function computeMessageClusters(
    messages: readonly Message[],
    options?: ClusterOptions,
): ClusteredMessage[] {
    const segments: { start: number; end: number }[] = [];
    let segStart = 0;
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].kind === 'user-text') {
            segments.push({ start: segStart, end: i });
            segStart = i;
        }
    }
    segments.push({ start: segStart, end: messages.length });

    const result: ClusteredMessage[] = [];
    for (const seg of segments) {
        const clustered = clusterMessages(
            messages.slice(seg.start, seg.end),
            seg.start,
            options?.taskContentMap,
        );
        for (const cm of clustered) result.push(cm);
    }
    return result;
}

// Process a segment; may produce multiple timeline cards.

interface ClusterSnap {
    taskItems: TaskItem[];
    firstIdx: number;
    firstCreatedAt: number;
    hideSet: Set<number>;
    preCount: number;
}

function clusterMessages(
    messages: readonly Message[],
    offset: number,
    taskContentMap?: ReadonlyMap<string, string>,
): ClusteredMessage[] {
    if (messages.length === 0) return [];

    const clusterSnaps: ClusterSnap[] = [];

    let taskItems: TaskItem[] = [];
    let activeCount = 0;
    let currentTaskIdx = -1;
    const completedOnce = new Map<string, boolean>();
    const tidToIdx = new Map<string, number>();
    let hideSet = new Set<number>();
    const allHidden = new Set<number>();
    let firstTaskIdx = -1;
    let firstTaskCreatedAt = 0;
    const pendingUpdates: { tid: string; status: string }[] = [];
    let clusterStart = 0;
    let taskIdBase = 1;

    const recalcBase = (fromIdx: number) => {
        if (taskContentMap) return;
        let minTid = Infinity;
        let seenTc = false;
        for (let i = fromIdx; i < messages.length; i++) {
            const m = messages[i];
            if (m.kind === 'tool-call' && m.tool?.name === 'TaskCreate') seenTc = true;
            if (seenTc && m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate') {
                const n = parseInt(String((m.tool?.input?.taskId || m.tool?.input?.id)), 10);
                if (!isNaN(n) && n < minTid) minTid = n;
            }
        }
        if (isFinite(minTid)) taskIdBase = minTid;
        else taskIdBase = 1;
    };
    recalcBase(0);

    const resolveTaskIndex = (tid: string): number => {
        let mi = taskItems.findIndex((t) => t.id === tid);
        if (mi >= 0) return mi;
        const content = taskContentMap?.get(tid);
        if (content) {
            mi = taskItems.findIndex((t) => t.content === content || t.id === content);
            if (mi >= 0) { const n = parseInt(tid, 10); if (!isNaN(n)) taskIdBase = n - mi; tidToIdx.set(tid, mi); return mi; }
            mi = taskItems.findIndex((t) => t.content.includes(content) || content.includes(t.content));
            if (mi >= 0) { const n = parseInt(tid, 10); if (!isNaN(n)) taskIdBase = n - mi; tidToIdx.set(tid, mi); return mi; }
        }
        if (tidToIdx.has(tid)) return tidToIdx.get(tid)!;
        const num = parseInt(tid, 10);
        if (!isNaN(num)) {
            let pi = num - 1;
            if (pi >= 0 && pi < taskItems.length) { tidToIdx.set(tid, pi); return pi; }
            pi = num - taskIdBase;
            if (pi >= 0 && pi < taskItems.length) { tidToIdx.set(tid, pi); return pi; }
        }
        return -1;
    };

    const applyTaskUpdate = (tid: string, status: string) => {
        const mi = resolveTaskIndex(tid);
        if (mi < 0 || mi >= taskItems.length) return;
        const order: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
        const ns = status || taskItems[mi].status;
        if ((order[ns] ?? -1) > (order[taskItems[mi].status] ?? -1)) {
            taskItems[mi] = { ...taskItems[mi], status: ns as TaskItem['status'] };
        }
        if (ns === 'completed' && !completedOnce.get(taskItems[mi].id)) {
            completedOnce.set(taskItems[mi].id, true);
            activeCount = Math.max(0, activeCount - 1);
        }
        currentTaskIdx = mi;
    };

    const snapshotCluster = (preCount: number) => {
        if (taskItems.length === 0) return;
        const snap = new Set<number>();
        for (const idx of hideSet) { if (idx >= clusterStart) snap.add(idx); }
        clusterSnaps.push({
            taskItems: taskItems.map(t => ({ ...t })),
            firstIdx: firstTaskIdx, firstCreatedAt: firstTaskCreatedAt,
            hideSet: snap, preCount,
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

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];

        if (m.kind === 'tool-call' && m.tool?.name === 'TaskCreate') {
            if (activeCount === 0 && taskItems.length > 0) {
                let pre = 0;
                if (firstTaskIdx > clusterStart) {
                    for (let j = firstTaskIdx - 1; j >= clusterStart; j--) {
                        if (messages[j].kind === 'tool-call') { pre++; allHidden.add(j); }
                        else break;
                    }
                }
                snapshotCluster(pre);
                resetClusterState(i);
                clusterStart = i;
            }

            const input = m.tool?.input || {};
            const content = input.subject || input.description || input.activeForm || '';
            const descKey = input.description || '';
            const newIdx = taskItems.length;
            taskItems.push({ id: descKey || String(newIdx + 1), content, status: 'pending', collapsedCount: 0 });
            activeCount++;
            currentTaskIdx = newIdx;
            if (firstTaskIdx < 0) { firstTaskIdx = i; firstTaskCreatedAt = m.createdAt; }
            hideSet.add(i); allHidden.add(i);

            if (taskContentMap) {
                for (const [tid, tc] of taskContentMap) {
                    if (tc === content || tc === descKey || content.includes(tc) || tc.includes(content)) {
                        const n = parseInt(tid, 10);
                        if (!isNaN(n)) taskIdBase = n - newIdx;
                        tidToIdx.set(tid, newIdx);
                        break;
                    }
                }
            }

            for (const pu of pendingUpdates) {
                if (pu.status !== 'completed') applyTaskUpdate(pu.tid, pu.status);
            }
            pendingUpdates.length = 0;
        } else if (m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate') {
            const input = m.tool?.input || {};
            const tid = String(input.taskId || input.id || '');
            const status = String(input.status || '');

            if (firstTaskIdx < 0) {
                pendingUpdates.push({ tid, status });
                hideSet.add(i); allHidden.add(i);
                continue;
            }
            applyTaskUpdate(tid, status);
            hideSet.add(i); allHidden.add(i);
        } else if (m.kind === 'tool-call' && activeCount > 0) {
            if (currentTaskIdx >= 0 && currentTaskIdx < taskItems.length) {
                taskItems[currentTaskIdx].collapsedCount = (taskItems[currentTaskIdx].collapsedCount ?? 0) + 1;
            }
            hideSet.add(i); allHidden.add(i);
        }
    }

    if (taskItems.length > 0) {
        let pre = 0;
        if (firstTaskIdx > clusterStart) {
            for (let j = firstTaskIdx - 1; j >= clusterStart; j--) {
                if (messages[j].kind === 'tool-call') { pre++; allHidden.add(j); }
                else break;
            }
        }
        snapshotCluster(pre);
    }

    if (clusterSnaps.length === 0) return messages.slice();

    const result: ClusteredMessage[] = [];
    let cursor = 0;
    for (let ci = 0; ci < clusterSnaps.length; ci++) {
        const snap = clusterSnaps[ci];
        const nextFirst = ci + 1 < clusterSnaps.length ? clusterSnaps[ci + 1].firstIdx : messages.length;

        for (let i = cursor; i < snap.firstIdx; i++) {
            if (!allHidden.has(i)) result.push(messages[i]);
        }
        for (let i = snap.firstIdx; i < messages.length && i < nextFirst; i++) {
            if (allHidden.has(i)) {
                if (i === snap.firstIdx) {
                    const ct = snap.taskItems.reduce((sum, t) => sum + (t.collapsedCount ?? 0), 0) + snap.preCount;
                    result.push({
                        id: `task-timeline-${offset + snap.firstIdx}`,
                        kind: 'task-cluster',
                        tasks: snap.taskItems,
                        collapsedCount: ct,
                        createdAt: snap.firstCreatedAt,
                    });
                }
                continue;
            }
            result.push(messages[i]);
        }
        cursor = nextFirst;
    }
    return result;
}
