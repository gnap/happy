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
        // Full rescan: capture ALL TaskUpdate statuses, compute base from minTid
        globalTaskStatusMap.clear();
        _globalBase = 1;
        let _baseSeen = false;
        for (const m of messages) {
            if (m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate') {
                const input = m.tool.input || {};
                const tid = String(input.taskId || input.id || '');
                const st = String(input.status || '');
                if (st && (!globalTaskStatusMap.has(tid) || (statusOrder[st] ?? -1) > (statusOrder[globalTaskStatusMap.get(tid)!] ?? -1))) {
                    globalTaskStatusMap.set(tid, st);
                }
                const n = parseInt(tid, 10);
                if (!isNaN(n)) {
                    if (!_baseSeen) { _globalBase = n; _baseSeen = true; }
                    else if (n < _globalBase) _globalBase = n;
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

    for (const seg of segments) {
        const segBase = _globalBase + cumulativeTotal;
        const clustered = clusterSegment(
            messages.slice(seg.start, seg.end),
            seg.start,
            options?.taskContentMap,
            segBase,
            globalTaskStatusMap,
        );
        for (const cm of clustered) {
            result.push(cm);
            if (cm.kind === 'task-cluster') cumulativeTotal += cm.tasks.length;
        }
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
    globalStatusMap: Map<string, string>,
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
    let taskIdBase = segmentBase;

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

    const snapshotCluster = (preCount: number) => {
        if (taskItems.length === 0) return;
        // Supplement display status from global pre-scan, but only apply
        // 'in_progress' — never 'completed', which must come from within-segment
        // TaskUpdates (global map spans all segments and can misattribute).
        const promote = (current: string, candidate: string) =>
            candidate === 'in_progress' && (statusOrder[candidate] ?? -1) > (statusOrder[current] ?? -1);
        // Step 1: exact mapping via tidToIdx
        const matched = new Set<number>();
        for (const [tid, idx] of tidToIdx) {
            if (idx >= 0 && idx < taskItems.length) {
                const gs = globalStatusMap.get(tid);
                if (gs && promote(taskItems[idx].status, gs)) {
                    taskItems[idx] = { ...taskItems[idx], status: gs as TaskItem['status'] };
                }
                matched.add(idx);
            }
        }
        // Step 2: base+idx heuristic for unmatched tasks
        for (let idx = 0; idx < taskItems.length; idx++) {
            if (matched.has(idx)) continue;
            for (const base of [taskIdBase, 1]) {
                const tid = String(base + idx);
                if (tidToIdx.has(tid) && tidToIdx.get(tid) !== idx) continue;
                const gs = globalStatusMap.get(tid);
                if (gs && promote(taskItems[idx].status, gs)) {
                    taskItems[idx] = { ...taskItems[idx], status: gs as TaskItem['status'] };
                    break;
                }
            }
        }
        const snap = new Set(hideSet);
        clusterSnaps.push({
            taskItems: taskItems.map(t => ({ ...t })),
            firstIdx: firstTaskIdx, firstCreatedAt: firstTaskCreatedAt,
            hideSet: snap, preCount,
        });
    };

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];

        if (m.kind === 'tool-call' && m.tool?.name === 'TaskCreate') {
            const input = m.tool?.input || {};
            const content = input.subject || input.description || input.activeForm || '';
            const descKey = input.description || '';
            const newIdx = taskItems.length;
            taskItems.push({ id: descKey || String(newIdx + 1), content, status: 'pending', collapsedCount: 0 });
            activeCount++;
            currentTaskIdx = newIdx;
            if (firstTaskIdx < 0) { firstTaskIdx = i; firstTaskCreatedAt = m.createdAt; }
            hideSet.add(i); allHidden.add(i);

            if (taskContentMap && taskContentMap.size > 0) {
                // Prefer matching by TaskCreate's own taskId (from input.taskId / input.id).
                // Falls back to exact content match (fuzzy includes removed — misattributes).
                const createTid = String(input.taskId || input.id || '');
                if (createTid && taskContentMap.has(createTid)) {
                    tidToIdx.set(createTid, newIdx);
                } else {
                    for (const [tid, tc] of taskContentMap) {
                        if (tc === content || tc === descKey) {
                            tidToIdx.set(tid, newIdx);
                            break;
                        }
                    }
                }
            }

            for (const pu of pendingUpdates) {
                if (pu.status !== 'completed') {
                    applyTaskUpdate(pu.tid, pu.status);
                } else {
                    // Set completed status directly (don't affect activeCount —
                    // that's managed by real TaskUpdate messages in the stream)
                    const mi = resolveTaskIndex(pu.tid);
                    if (mi >= 0 && mi < taskItems.length
                        && (statusOrder[pu.status] ?? -1) > (statusOrder[taskItems[mi].status] ?? -1)) {
                        taskItems[mi] = { ...taskItems[mi], status: pu.status as TaskItem['status'] };
                    }
                }
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
        if (firstTaskIdx > 0) {
            for (let j = firstTaskIdx - 1; j >= 0; j--) {
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
