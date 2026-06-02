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

// Incremental cache: avoids re-scanning all messages on every render.
// Keyed by the messages array reference (which changes when new msgs arrive).
let _cachedArray: readonly Message[] | null = null;
let _cachedLen = 0;
const globalTaskStatusMap = new Map<string, string>();
let _globalBase = 1;
const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };

function updateGlobalScan(messages: readonly Message[]) {
    // If it's the same array ref with more messages, scan only new ones
    if (messages === _cachedArray && messages.length >= _cachedLen) {
        for (let i = _cachedLen; i < messages.length; i++) {
            const m = messages[i];
            if (m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate') {
                const input = m.tool.input || {};
                const tid = String(input.taskId || input.id || '');
                const st = String(input.status || '');
                if (st && (!globalTaskStatusMap.has(tid) || (statusOrder[st] ?? -1) > (statusOrder[globalTaskStatusMap.get(tid)!] ?? -1))) {
                    globalTaskStatusMap.set(tid, st);
                }
            }
            // Also update globalBase from new messages
            if (m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate') {
                const n = parseInt(String((m.tool?.input?.taskId || m.tool?.input?.id)), 10);
                if (!isNaN(n) && n < _globalBase) _globalBase = n;
            }
        }
    } else {
        // Full rescan: capture ALL TaskUpdate statuses (no seenTc filter)
        globalTaskStatusMap.clear();
        _globalBase = 1;
        let seenTc = false;
        for (const m of messages) {
            if (m.kind === 'tool-call' && m.tool?.name === 'TaskCreate') seenTc = true;
            if (m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate') {
                const input = m.tool.input || {};
                const tid = String(input.taskId || input.id || '');
                const st = String(input.status || '');
                if (st && (!globalTaskStatusMap.has(tid) || (statusOrder[st] ?? -1) > (statusOrder[globalTaskStatusMap.get(tid)!] ?? -1))) {
                    globalTaskStatusMap.set(tid, st);
                }
                if (seenTc) {
                    const n = parseInt(tid, 10);
                    if (!isNaN(n) && n < _globalBase) _globalBase = n;
                }
            }
        }
    }
    _cachedArray = messages;
    _cachedLen = messages.length;
}

// ---------------------------------------------------------------------------
// Top-level: split at user-text boundaries, process each segment independently.
// Uses incremental global scan for TaskUpdate statuses and taskId base.
// ---------------------------------------------------------------------------

export function computeMessageClusters(
    messages: readonly Message[],
    options?: ClusterOptions,
): ClusteredMessage[] {
    // ---- Incremental global scan --------------------------------------------
    updateGlobalScan(messages);

    // ---- Split into segments -----------------------------------------------
    const segments: { start: number; end: number }[] = [];
    let segStart = 0;
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].kind === 'user-text') {
            segments.push({ start: segStart, end: i });
            segStart = i;
        }
    }
    segments.push({ start: segStart, end: messages.length });

    // ---- Process each segment ----------------------------------------------
    const result: ClusteredMessage[] = [];
    let cumulativeTotal = 0;
    let segmentOffset = 0;

    for (const seg of segments) {
        const segBase = _globalBase + cumulativeTotal;
        const clustered = clusterSegment(
            messages.slice(seg.start, seg.end),
            seg.start,
            options?.taskContentMap,
            segBase,
            segmentOffset,
            globalTaskStatusMap,
        );
        for (const cm of clustered) {
            result.push(cm);
            if (cm.kind === 'task-cluster') cumulativeTotal += cm.tasks.length;
        }
        segmentOffset = cumulativeTotal;
    }

    // ---- Deduplicate adjacent user-text echoes ------------------------------
    for (let i = result.length - 1; i >= 1; i--) {
        const a = result[i], b = result[i - 1];
        if (a.kind === 'user-text' && b.kind === 'user-text'
            && a.text === b.text && Math.abs(a.createdAt - b.createdAt) <= 5000) {
            result.splice(i - 1, 1);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Core clustering on a single segment.
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
    taskContentMap: ReadonlyMap<string, string> | undefined,
    segmentBase: number,
    segmentOffset: number,
    globalTaskStatusMap: Map<string, string>,
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
    let taskIdBase = segmentBase;
    let cumulativeTaskCount = 0;

    const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };

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
        const ns = status || taskItems[mi].status;
        if ((statusOrder[ns] ?? -1) > (statusOrder[taskItems[mi].status] ?? -1)) {
            taskItems[mi] = { ...taskItems[mi], status: ns as TaskItem['status'] };
        }
        if (ns === 'completed' && !completedOnce.get(taskItems[mi].id)) {
            completedOnce.set(taskItems[mi].id, true);
            activeCount = Math.max(0, activeCount - 1);
        }
        currentTaskIdx = mi;
    };

    /** Apply any known status from the global pre-scan to a task item. */
    const applyGlobalStatus = (item: TaskItem, idx: number) => {
        // Try both per-cluster base and legacy base (1-indexed)
        for (const base of [taskIdBase, 1]) {
            const tid = String(base + idx);
            const gs = globalTaskStatusMap.get(tid);
            if (gs && (statusOrder[gs] ?? -1) > (statusOrder[item.status] ?? -1)) {
                item.status = gs as TaskItem['status'];
                if (gs === 'completed' && !completedOnce.get(item.id)) {
                    completedOnce.set(item.id, true);
                    activeCount = Math.max(0, activeCount - 1);
                }
                return;
            }
        }
    };

    const snapshotCluster = (preCount: number) => {
        if (taskItems.length === 0) return;
        const snap = new Set<number>();
        for (const idx of hideSet) { if (idx >= clusterStart) snap.add(idx); }
        // Apply global status before snapshotting
        for (let i = 0; i < taskItems.length; i++) {
            applyGlobalStatus(taskItems[i], i);
        }
        clusterSnaps.push({
            taskItems: taskItems.map(t => ({ ...t })),
            firstIdx: firstTaskIdx, firstCreatedAt: firstTaskCreatedAt,
            hideSet: snap, preCount,
        });
    };

    const resetClusterState = () => {
        cumulativeTaskCount += taskItems.length;
        taskIdBase = segmentBase + cumulativeTaskCount;
        taskItems = [];
        activeCount = 0;
        currentTaskIdx = -1;
        completedOnce.clear();
        tidToIdx.clear();
        hideSet = new Set<number>();
        firstTaskIdx = -1;
        firstTaskCreatedAt = 0;
        pendingUpdates.length = 0;
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
                resetClusterState();
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
