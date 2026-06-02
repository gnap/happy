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

// ---------------------------------------------------------------------------
// State-machine timeline replay.
//
// Forks:  TaskCreate → pending → TaskUpdate(in_progress) → TaskUpdate(completed)
// Joins:  while any task is active (activeCount > 0), non-task tool calls
//         are absorbed into the current task's collapsedCount.
//
// Turns:  user-text messages delimit turns; each turn emits one timeline card
//         at the position of its first TaskCreate.
//
// Pre-turn tool calls before the first TaskCreate are buffered and absorbed
// into the turn's collapsedCount (backward extension).
//
// New messages integrate into the state machine incrementally — just advance
// the state with each message. No full rescan needed.
// ---------------------------------------------------------------------------

interface TaskState {
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    collapsedCount: number;
}

interface TurnAccumulator {
    tasks: TaskState[];
    activeCount: number;
    completedOnce: Set<string>;
    tidToIdx: Map<string, number>;
    pendingUpdates: { tid: string; status: string }[];
    firstTaskIdx: number;
    firstTaskCreatedAt: number;
    preTaskToolCalls: number;
    // Tool calls buffered before first TaskCreate — emitted if no tasks appear
    preTaskBuffer: Message[];
}

const STATUS_ORDER: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };

// Global pre-scan: collect TaskUpdate statuses once.
// The state machine handles per-turn status updates, but TaskUpdates
// that arrive before their TaskCreates (cross-turn) need this fallback.
let _cachedLen = 0;
let _cachedMessages: readonly Message[] | null = null;
const _globalStatus = new Map<string, string>();
let _globalBase = 1;

function updateGlobalScan(messages: readonly Message[]) {
    if (messages === _cachedMessages && messages.length >= _cachedLen) {
        for (let i = _cachedLen; i < messages.length; i++) {
            scanMessage(messages[i]);
        }
    } else {
        _globalStatus.clear();
        _globalBase = 1;
        _globalBaseSeen = false;
        for (const m of messages) scanMessage(m);
    }
    _cachedMessages = messages;
    _cachedLen = messages.length;
}

let _globalBaseSeen = false;

function scanMessage(m: Message) {
    if (m.kind !== 'tool-call') return;
    const input = m.tool?.input || {};
    if (m.tool?.name === 'TaskUpdate') {
        const tid = String(input.taskId || input.id || '');
        const st = String(input.status || '');
        if (st && (!_globalStatus.has(tid) || (STATUS_ORDER[st] ?? -1) > (STATUS_ORDER[_globalStatus.get(tid)!] ?? -1))) {
            _globalStatus.set(tid, st);
        }
        const n = parseInt(tid, 10);
        if (!isNaN(n)) {
            if (!_globalBaseSeen) { _globalBase = n; _globalBaseSeen = true; }
            else if (n < _globalBase) _globalBase = n;
        }
    }
}

export function computeMessageClusters(
    messages: readonly Message[],
    _options?: ClusterOptions,
): ClusteredMessage[] {
    updateGlobalScan(messages);
    const result: ClusteredMessage[] = [];

    let turn: TurnAccumulator | null = null;

    const ensureTurn = (idx: number): TurnAccumulator => {
        if (!turn) {
            turn = {
                tasks: [],
                activeCount: 0,
                completedOnce: new Set(),
                tidToIdx: new Map(),
                pendingUpdates: [],
                firstTaskIdx: idx,
                firstTaskCreatedAt: 0,
                preTaskToolCalls: 0,
                preTaskBuffer: [],
            };
        }
        return turn;
    };

    const resolveTaskIndex = (tid: string, t: TurnAccumulator): number => {
        let mi = t.tasks.findIndex(tk => tk.id === tid);
        if (mi >= 0) return mi;
        if (t.tidToIdx.has(tid)) return t.tidToIdx.get(tid)!;
        const num = parseInt(tid, 10);
        if (!isNaN(num)) {
            let pi = num - 1;
            if (pi >= 0 && pi < t.tasks.length) { t.tidToIdx.set(tid, pi); return pi; }
            pi = num - _globalBase;
            if (pi >= 0 && pi < t.tasks.length) { t.tidToIdx.set(tid, pi); return pi; }
            if (t.tasks.length === 1) { t.tidToIdx.set(tid, 0); return 0; }
        }
        return -1;
    };

    const applyUpdate = (tid: string, status: string, t: TurnAccumulator) => {
        const mi = resolveTaskIndex(tid, t);
        if (mi < 0 || mi >= t.tasks.length) return;
        const ns = status || t.tasks[mi].status;
        if ((STATUS_ORDER[ns] ?? -1) > (STATUS_ORDER[t.tasks[mi].status] ?? -1)) {
            t.tasks[mi] = { ...t.tasks[mi], status: ns as TaskItem['status'] };
        }
        if (ns === 'completed' && !t.completedOnce.has(t.tasks[mi].id)) {
            t.completedOnce.add(t.tasks[mi].id);
            t.activeCount = Math.max(0, t.activeCount - 1);
        }
    };

    const emitTurn = (t: TurnAccumulator) => {
        if (t.tasks.length === 0) {
            for (const bm of t.preTaskBuffer) result.push(bm);
            return;
        }
        // Apply global status to tasks (handles cross-turn & pre-TaskCreate TaskUpdates)
        for (let i = 0; i < t.tasks.length; i++) {
            const gs = _globalStatus.get(String(i + 1));
            if (!gs) continue;
            if ((STATUS_ORDER[gs] ?? -1) > (STATUS_ORDER[t.tasks[i].status] ?? -1)) {
                t.tasks[i] = { ...t.tasks[i], status: gs as TaskItem['status'] };
            }
        }
        const collapsedToolCount =
            t.tasks.reduce((s, tk) => s + tk.collapsedCount, 0) + t.preTaskToolCalls;
        result.push({
            id: `task-timeline-${t.firstTaskIdx}`,
            kind: 'task-cluster',
            tasks: t.tasks,
            collapsedCount: collapsedToolCount,
            createdAt: t.firstTaskCreatedAt,
        });
    };

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];

        // user-text closes current turn
        if (m.kind === 'user-text') {
            if (turn) emitTurn(turn);
            turn = null;
            result.push(m);
            continue;
        }

        // Non-tool-call messages pass through
        if (m.kind !== 'tool-call') {
            result.push(m);
            continue;
        }

        const t = ensureTurn(i);

        if (m.tool?.name === 'TaskCreate') {
            const input = m.tool?.input || {};
            const content = input.subject || input.description || input.activeForm || '';
            const descKey = input.description || '';
            t.tasks.push({
                id: descKey || String(t.tasks.length + 1),
                content,
                status: 'pending',
                collapsedCount: 0,
            });
            t.activeCount++;
            if (t.firstTaskCreatedAt === 0) t.firstTaskCreatedAt = m.createdAt;

            // Replay buffered TaskUpdates
            for (const pu of t.pendingUpdates) {
                if (pu.status !== 'completed') applyUpdate(pu.tid, pu.status, t);
            }
            t.pendingUpdates.length = 0;
            continue;
        }

        if (m.tool?.name === 'TaskUpdate') {
            const input = m.tool?.input || {};
            const tid = String(input.taskId || input.id || '');
            const status = String(input.status || '');

            if (t.tasks.length === 0) {
                t.pendingUpdates.push({ tid, status });
                continue;
            }
            applyUpdate(tid, status, t);
            continue;
        }

        // Non-task tool call while tasks are active → absorb
        if (t.activeCount > 0) {
            const lastIdx = t.tasks.length - 1;
            if (lastIdx >= 0) {
                t.tasks[lastIdx] = {
                    ...t.tasks[lastIdx],
                    collapsedCount: (t.tasks[lastIdx].collapsedCount ?? 0) + 1,
                };
            }
            continue;
        }

        // No TaskCreate yet AND no active tasks: buffer for backward extension.
        // If a TaskCreate follows, these are absorbed into collapsedCount.
        // If not, they're emitted as-is when the turn closes.
        if (t.tasks.length === 0 && t.activeCount === 0) {
            t.preTaskBuffer.push(m);
            t.preTaskToolCalls++;
            continue;
        }

        // No active tasks, tasks exist: pass through
        result.push(m);
    }

    // Final turn
    if (turn) emitTurn(turn);

    // Deduplicate adjacent user-text echoes
    for (let i = result.length - 1; i >= 1; i--) {
        const a = result[i], b = result[i - 1];
        if (a.kind === 'user-text' && b.kind === 'user-text'
            && a.text === b.text && Math.abs(a.createdAt - b.createdAt) <= 5000) {
            result.splice(i - 1, 1);
        }
    }
    return result;
}
