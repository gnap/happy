import { createId } from '@paralleldrive/cuid2';
import type { RawJSONLines } from '@/claude/types';
import {
    createEnvelope,
    type SessionEnvelope,
    type SessionTurnEndStatus,
} from '@slopus/happy-wire';

export type ClaudeSessionProtocolState = {
    currentTurnId: string | null;
    uuidToProviderSubagent?: Map<string, string>;
    taskPromptToSubagents?: Map<string, string[]>;
    providerSubagentToSessionSubagent?: Map<string, string>;
    subagentTitles?: Map<string, string>;
    bufferedSubagentMessages?: Map<string, RawJSONLines[]>;
    hiddenParentToolCalls?: Set<string>;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
    taskCallBySubagent?: Map<string, string>; // session subagent cuid -> Task provider tool call ID
    bgTaskIdToCallId?: Map<string, string>; // background task_id → Bash call ID
    lastTaskCreateCallId?: string; // most recent TaskCreate call ID for Agent remapping
    /** SDK task ID ("1", "2", …) → provider tool call ID (TaskUpdate/TaskGet remapping). */
    sdkTaskIdToCallId?: Map<string, string>;
    /** Provider call IDs that are TaskCreate calls (for result parsing in user handler). */
    taskCreateCallIds?: Set<string>;
    /** Number of upcoming non-sidechain user text messages to suppress (e.g. inbox turn prompts). */
    suppressNextUserTextCount?: number;
};

type ClaudeMapperResult = {
    currentTurnId: string | null;
    envelopes: SessionEnvelope[];
};

function pickProviderSubagent(message: RawJSONLines): string | undefined {
    const raw = message as { parent_tool_use_id?: unknown; parentToolUseId?: unknown };
    if (typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0) {
        return raw.parent_tool_use_id;
    }
    if (typeof raw.parentToolUseId === 'string' && raw.parentToolUseId.length > 0) {
        return raw.parentToolUseId;
    }
    return undefined;
}

function getUuidToProviderSubagent(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.uuidToProviderSubagent) {
        state.uuidToProviderSubagent = new Map<string, string>();
    }
    return state.uuidToProviderSubagent;
}

function getTaskPromptToSubagents(state: ClaudeSessionProtocolState): Map<string, string[]> {
    if (!state.taskPromptToSubagents) {
        state.taskPromptToSubagents = new Map<string, string[]>();
    }
    return state.taskPromptToSubagents;
}

function getProviderSubagentToSessionSubagent(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.providerSubagentToSessionSubagent) {
        state.providerSubagentToSessionSubagent = new Map<string, string>();
    }
    return state.providerSubagentToSessionSubagent;
}

function getSessionSubagentIdForProviderSubagent(
    state: ClaudeSessionProtocolState,
    providerSubagent: string,
): string | undefined {
    return getProviderSubagentToSessionSubagent(state).get(providerSubagent);
}

function ensureSessionSubagentIdForProviderSubagent(
    state: ClaudeSessionProtocolState,
    providerSubagent: string,
): string {
    const existing = getSessionSubagentIdForProviderSubagent(state, providerSubagent);
    if (existing) {
        return existing;
    }

    const created = createId();
    getProviderSubagentToSessionSubagent(state).set(providerSubagent, created);
    return created;
}

function getSubagentTitles(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.subagentTitles) {
        state.subagentTitles = new Map<string, string>();
    }
    return state.subagentTitles;
}

function getBufferedSubagentMessages(state: ClaudeSessionProtocolState): Map<string, RawJSONLines[]> {
    if (!state.bufferedSubagentMessages) {
        state.bufferedSubagentMessages = new Map<string, RawJSONLines[]>();
    }
    return state.bufferedSubagentMessages;
}

function getHiddenParentToolCalls(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.hiddenParentToolCalls) {
        state.hiddenParentToolCalls = new Set<string>();
    }
    return state.hiddenParentToolCalls;
}

function bufferSubagentMessage(state: ClaudeSessionProtocolState, subagent: string, message: RawJSONLines): void {
    const buffer = getBufferedSubagentMessages(state);
    const queue = buffer.get(subagent) ?? [];
    queue.push(message);
    buffer.set(subagent, queue);
}

function consumeBufferedSubagentMessages(state: ClaudeSessionProtocolState, subagent: string): RawJSONLines[] {
    const buffer = getBufferedSubagentMessages(state);
    const queue = buffer.get(subagent) ?? [];
    buffer.delete(subagent);
    return queue;
}

function getStartedSubagents(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.startedSubagents) {
        state.startedSubagents = new Set<string>();
    }
    return state.startedSubagents;
}

function getActiveSubagents(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.activeSubagents) {
        state.activeSubagents = new Set<string>();
    }
    return state.activeSubagents;
}

function getTaskCallBySubagent(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.taskCallBySubagent) {
        state.taskCallBySubagent = new Map<string, string>();
    }
    return state.taskCallBySubagent;
}

function ensureBgTaskIdToCallId(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.bgTaskIdToCallId) {
        state.bgTaskIdToCallId = new Map<string, string>();
    }
    return state.bgTaskIdToCallId;
}

function ensureSdkTaskIdToCallId(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.sdkTaskIdToCallId) {
        state.sdkTaskIdToCallId = new Map<string, string>();
    }
    return state.sdkTaskIdToCallId;
}

function ensureTaskCreateCallIds(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.taskCreateCallIds) {
        state.taskCreateCallIds = new Set<string>();
    }
    return state.taskCreateCallIds;
}

function parseTaskCreateResult(result: unknown): { id: string; subject: string } | null {
    if (typeof result !== 'string') return null;
    try {
        const parsed = JSON.parse(result);
        if (parsed?.task?.id && typeof parsed.task.id === 'string') {
            return { id: parsed.task.id, subject: parsed.task.subject || '' };
        }
    } catch {}
    // Fallback: interactive mode text "Task #N created successfully: ..."
    const m = result.match(/^Task #(\d+) created(?: successfully)?:\s*(.*)/i);
    if (m) {
        return { id: m[1], subject: (m[2] || '').trim() };
    }
    return null;
}

function extractBackgroundTaskId(block: Record<string, unknown>, message: RawJSONLines): string | undefined {
    // Try toolUseResult first (JSONL format)
    const tur = message.toolUseResult as Record<string, unknown> | undefined;
    if (tur?.backgroundTaskId && typeof tur.backgroundTaskId === 'string') {
        return tur.backgroundTaskId;
    }
    // Try tool_use_result (raw stream format)
    const tur2 = (message as Record<string, unknown>).tool_use_result as Record<string, unknown> | undefined;
    if (tur2?.backgroundTaskId && typeof tur2.backgroundTaskId === 'string') {
        return tur2.backgroundTaskId;
    }
    // Fallback: parse from content string "Command running in background with ID: xxx"
    const content = block.content;
    if (typeof content === 'string') {
        const m = content.match(/background with ID:\s*(\w+)/);
        if (m) return m[1];
    }
    return undefined;
}

function pickUuid(message: RawJSONLines): string | undefined {
    const raw = message as { uuid?: unknown };
    if (typeof raw.uuid === 'string' && raw.uuid.length > 0) {
        return raw.uuid;
    }
    return undefined;
}

function pickParentUuid(message: RawJSONLines): string | undefined {
    const raw = message as { parentUuid?: unknown; parentUUID?: unknown };
    if (typeof raw.parentUuid === 'string' && raw.parentUuid.length > 0) {
        return raw.parentUuid;
    }
    if (typeof raw.parentUUID === 'string' && raw.parentUUID.length > 0) {
        return raw.parentUUID;
    }
    return undefined;
}

function isSidechainMessage(message: RawJSONLines): boolean {
    const raw = message as { isSidechain?: unknown; parent_tool_use_id?: unknown };
    // Legacy interactive mode sets isSidechain:true; SDK remote mode uses parent_tool_use_id.
    return raw.isSidechain === true
        || (raw.parent_tool_use_id !== undefined && raw.parent_tool_use_id !== null);
}

function normalizePrompt(prompt: string): string {
    return prompt.trim();
}

function queueTaskPromptSubagent(state: ClaudeSessionProtocolState, prompt: string, subagent: string): void {
    const normalized = normalizePrompt(prompt);
    if (normalized.length === 0) {
        return;
    }

    const promptMap = getTaskPromptToSubagents(state);
    const queue = promptMap.get(normalized) ?? [];
    if (!queue.includes(subagent)) {
        queue.push(subagent);
    }
    promptMap.set(normalized, queue);
}

function isKnownTaskPrompt(state: ClaudeSessionProtocolState, prompt: string): boolean {
    const normalized = normalizePrompt(prompt);
    if (normalized.length === 0) return false;
    return getTaskPromptToSubagents(state).has(normalized);
}

function consumeTaskPromptSubagent(state: ClaudeSessionProtocolState, prompt: string): string | undefined {
    const normalized = normalizePrompt(prompt);
    if (normalized.length === 0) {
        return undefined;
    }

    const promptMap = getTaskPromptToSubagents(state);
    const queue = promptMap.get(normalized);
    if (!queue || queue.length === 0) {
        return undefined;
    }

    const subagent = queue.shift();
    if (queue.length === 0) {
        promptMap.delete(normalized);
    }
    return subagent;
}

function consumeSinglePendingTaskSubagent(state: ClaudeSessionProtocolState): string | undefined {
    const promptMap = getTaskPromptToSubagents(state);
    let candidateKey: string | null = null;
    let candidateSubagent: string | null = null;

    for (const [prompt, queue] of promptMap.entries()) {
        if (queue.length === 0) {
            continue;
        }

        if (candidateKey !== null) {
            return undefined;
        }

        candidateKey = prompt;
        candidateSubagent = queue[0] ?? null;
    }

    if (!candidateKey || !candidateSubagent) {
        return undefined;
    }

    const queue = promptMap.get(candidateKey);
    if (!queue || queue.length === 0) {
        return undefined;
    }

    queue.shift();
    if (queue.length === 0) {
        promptMap.delete(candidateKey);
    }

    return candidateSubagent;
}

function pickSidechainRootPrompt(message: RawJSONLines): string | undefined {
    if (message.type !== 'user') {
        return undefined;
    }

    if (typeof message.message?.content === 'string') {
        const normalized = normalizePrompt(message.message.content);
        return normalized.length > 0 ? normalized : undefined;
    }

    return undefined;
}

function resolveProviderSubagent(message: RawJSONLines, state: ClaudeSessionProtocolState): string | undefined {
    const explicitSubagent = pickProviderSubagent(message);
    if (explicitSubagent) {
        return explicitSubagent;
    }

    const parentUuid = pickParentUuid(message);
    if (parentUuid) {
        const inheritedSubagent = getUuidToProviderSubagent(state).get(parentUuid);
        if (inheritedSubagent) {
            return inheritedSubagent;
        }
    }

    if (!isSidechainMessage(message)) {
        return undefined;
    }

    const prompt = pickSidechainRootPrompt(message);
    if (prompt) {
        const matchedSubagent = consumeTaskPromptSubagent(state, prompt);
        if (matchedSubagent) {
            return matchedSubagent;
        }
    }

    if (!parentUuid) {
        return consumeSinglePendingTaskSubagent(state);
    }

    return undefined;
}

function rememberSubagentForMessage(message: RawJSONLines, state: ClaudeSessionProtocolState, providerSubagent: string | undefined): void {
    if (!providerSubagent) {
        return;
    }

    const uuid = pickUuid(message);
    if (!uuid) {
        return;
    }

    getUuidToProviderSubagent(state).set(uuid, providerSubagent);
}

function pickTaskPrompt(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }

    const prompt = (input as { prompt?: unknown }).prompt;
    if (typeof prompt !== 'string') {
        return undefined;
    }

    const normalized = normalizePrompt(prompt);
    return normalized.length > 0 ? normalized : undefined;
}

function pickTaskTitle(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }

    const record = input as Record<string, unknown>;
    // Prefer explicit human-readable title fields; never use subagent_type ("claude", "opus", etc.)
    for (const key of ['description', 'title']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    // Fall back to a truncated prompt so the card has something descriptive.
    const prompt = record['prompt'];
    if (typeof prompt === 'string' && prompt.trim().length > 0) {
        const trimmed = prompt.trim().replace(/\s+/g, ' ');
        return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
    }

    return undefined;
}

function setSubagentTitle(state: ClaudeSessionProtocolState, subagent: string, title: string | undefined): void {
    if (!title || title.trim().length === 0) {
        return;
    }
    getSubagentTitles(state).set(subagent, title.trim());
}

function maybeEmitSubagentStart(
    state: ClaudeSessionProtocolState,
    turn: string,
    subagent: string | undefined,
    envelopes: SessionEnvelope[],
): void {
    if (!subagent) {
        return;
    }

    const started = getStartedSubagents(state);
    if (started.has(subagent)) {
        return;
    }

    const title = getSubagentTitles(state).get(subagent);
    envelopes.push(createEnvelope('agent', {
        t: 'start',
        ...(title ? { title } : {}),
    }, { turn, subagent }));
    started.add(subagent);
    getActiveSubagents(state).add(subagent);
}

function maybeEmitSubagentStop(
    state: ClaudeSessionProtocolState,
    turn: string,
    subagent: string,
    envelopes: SessionEnvelope[],
): void {
    const active = getActiveSubagents(state);
    if (!active.has(subagent)) {
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'stop' }, { turn, subagent }));
    active.delete(subagent);
}

function clearSubagentTracking(state: ClaudeSessionProtocolState): void {
    getUuidToProviderSubagent(state).clear();
    getTaskPromptToSubagents(state).clear();
    getProviderSubagentToSessionSubagent(state).clear();
    getSubagentTitles(state).clear();
    getBufferedSubagentMessages(state).clear();
    getHiddenParentToolCalls(state).clear();
    getStartedSubagents(state).clear();
    getActiveSubagents(state).clear();
    getTaskCallBySubagent(state).clear();
    if (state.bgTaskIdToCallId) state.bgTaskIdToCallId.clear();
    if (state.sdkTaskIdToCallId) state.sdkTaskIdToCallId.clear();
    if (state.taskCreateCallIds) state.taskCreateCallIds.clear();
    state.lastTaskCreateCallId = undefined;
}

function ensureTurn(state: ClaudeSessionProtocolState, envelopes: SessionEnvelope[]): string {
    if (state.currentTurnId) {
        return state.currentTurnId;
    }

    const turnId = createId();
    envelopes.push(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
    state.currentTurnId = turnId;
    return turnId;
}

function closeTurn(
    state: ClaudeSessionProtocolState,
    status: SessionTurnEndStatus,
    envelopes: SessionEnvelope[],
    extras?: Record<string, unknown>,
): void {
    if (!state.currentTurnId) {
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'turn-end', status, ...(extras ?? {}) }, { turn: state.currentTurnId }));
    state.currentTurnId = null;
    clearSubagentTracking(state);
}

function toolTitle(name: string, input: unknown): string {
    if (input && typeof input === 'object') {
        const description = (input as { description?: unknown }).description;
        if (typeof description === 'string' && description.trim().length > 0) {
            return description.length > 80 ? `${description.slice(0, 77)}...` : description;
        }
        // Models sometimes skip the optional `description` (sonnet does this often for Bash);
        // fall back to a short echo of the primary input so the App card has something
        // descriptive instead of the generic "Bash call".
        const fallbackKeys = ['command', 'cmd', 'query', 'pattern', 'file_path', 'path', 'url'];
        for (const key of fallbackKeys) {
            const value = (input as Record<string, unknown>)[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                const trimmed = value.trim().replace(/\s+/g, ' ');
                return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
            }
        }
    }
    return `${name} call`;
}

function toToolArgs(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        return input as Record<string, unknown>;
    }
    if (input === undefined) {
        return {};
    }
    return { input };
}

/** Mark the next N non-sidechain user text messages as internal CLI prompts to suppress. */
export function suppressNextUserText(state: ClaudeSessionProtocolState, count = 1): void {
    state.suppressNextUserTextCount = (state.suppressNextUserTextCount ?? 0) + count;
}

export function closeClaudeTurnWithStatus(
    state: ClaudeSessionProtocolState,
    status: SessionTurnEndStatus,
    extras?: Record<string, unknown>,
): ClaudeMapperResult {
    const envelopes: SessionEnvelope[] = [];
    closeTurn(state, status, envelopes, extras);
    return {
        currentTurnId: state.currentTurnId,
        envelopes,
    };
}

export function mapClaudeLogMessageToSessionEnvelopes(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
): ClaudeMapperResult {
    return mapClaudeLogMessageToSessionEnvelopesInternal(message, state);
}

function mapClaudeLogMessageToSessionEnvelopesInternal(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
): ClaudeMapperResult {
    const envelopes: SessionEnvelope[] = [];
    const providerSubagent = resolveProviderSubagent(message, state);
    const subagent = providerSubagent
        ? getSessionSubagentIdForProviderSubagent(state, providerSubagent)
        : undefined;
    rememberSubagentForMessage(message, state, providerSubagent);

    if (providerSubagent && !subagent) {
        bufferSubagentMessage(state, providerSubagent, message);
        return {
            currentTurnId: state.currentTurnId,
            envelopes: [],
        };
    }

    if (message.type === 'summary') {
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'system') {
        // task_notification: background task (Monitor, Bash run_in_background) completed.
        // Emit a tool-call-end so the App's tool card transitions from "running" to done.
        const subtype = (message as Record<string, unknown>).subtype;
        if (subtype === 'task_notification') {
            const toolUseId = (message as Record<string, unknown>).tool_use_id;
            const status = (message as Record<string, unknown>).status;
            if (typeof toolUseId === 'string' && toolUseId.length > 0) {
                const turnId = ensureTurn(state, envelopes);
                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-end',
                    call: toolUseId,
                    result: { task_notification: status },
                }, { turn: turnId }));
            }
        }
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'assistant') {
        const turnId = ensureTurn(state, envelopes);
        const taskCallId = subagent ? getTaskCallBySubagent(state).get(subagent) : undefined;
        maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        const blocks = Array.isArray(message.message?.content) ? message.message.content : [];

        for (const block of blocks) {
            if (block.type === 'text' && typeof block.text === 'string') {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.text }, { turn: turnId, subagent, ...(taskCallId ? { taskCall: taskCallId } : {}) }));
                continue;
            }

            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                // Thinking blocks are intentionally not surfaced to the App:
                // they flood the chat, waste bandwidth, and break the assistant's
                // signed-thinking contract when echoed back. Cursor does the same.
                // (Re-suppress: this had landed via d8ff7d8e and was reverted by
                // 768d5d90's rebase. See also fallback toolTitle below.)
                continue;
            }

            if (block.type === 'tool_use') {
                const call = typeof block.id === 'string' && block.id.length > 0 ? block.id : createId();
                const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown';
                const args = toToolArgs(block.input);
                const title = toolTitle(name, block.input);
                const sessionSubagentForCall = ensureSessionSubagentIdForProviderSubagent(state, call);
                if (name === 'Task') {
                    getHiddenParentToolCalls(state).add(call);
                    continue;
                }

                // Track most recent TaskCreate for Agent remapping, and register
                // the call ID so we can parse its result (SDK task ID) later.
                if (name === 'TaskCreate') {
                    state.lastTaskCreateCallId = call;
                    ensureTaskCreateCallIds(state).add(call);
                }

                // TaskOutput/TaskStop: link to original Bash card via bgTaskId
                if (name === 'TaskOutput' || name === 'TaskStop') {
                    const taskId = (block.input as Record<string, unknown>)?.task_id as string | undefined;
                    if (taskId && state.bgTaskIdToCallId) {
                        const bashCallId = state.bgTaskIdToCallId.get(taskId);
                        if (bashCallId) {
                            getTaskCallBySubagent(state).set(sessionSubagentForCall, bashCallId);
                        }
                    }
                }

                // TaskUpdate / TaskGet: remap to the original TaskCreate card via SDK task ID.
                if (name === 'TaskUpdate' || name === 'TaskGet') {
                    const inputTaskId = (block.input as Record<string, unknown>)?.taskId as string | undefined;
                    if (inputTaskId && state.sdkTaskIdToCallId) {
                        const taskCreateCallId = state.sdkTaskIdToCallId.get(inputTaskId);
                        if (taskCreateCallId) {
                            getTaskCallBySubagent(state).set(sessionSubagentForCall, taskCreateCallId);
                        }
                    }
                }

                // TaskGet / TaskList: read-only management ops — absorb like TaskUpdate.
                // Emit tool-call-start so tool-call-end can link; App will hide the card.

                // Agent: setup subagent tracking so child messages link via taskCall.
                // Hide the card only when a TaskCreate exists to remap children to.
                if (name === 'Agent') {
                    const prompt = pickTaskPrompt(block.input);
                    if (prompt) {
                        queueTaskPromptSubagent(state, prompt, call);
                    }
                    setSubagentTitle(state, sessionSubagentForCall, pickTaskTitle(block.input) ?? prompt);
                    const mappedTaskCall = state.lastTaskCreateCallId ?? call;
                    getTaskCallBySubagent(state).set(sessionSubagentForCall, mappedTaskCall);

                    const buffered = consumeBufferedSubagentMessages(state, call);
                    for (const bufferedMessage of buffered) {
                        const replay = mapClaudeLogMessageToSessionEnvelopesInternal(bufferedMessage, state);
                        envelopes.push(...replay.envelopes);
                    }
                    if (state.lastTaskCreateCallId) {
                        getHiddenParentToolCalls(state).add(call);
                        continue;
                    }
                    // No TaskCreate (e.g. inbox turn): fall through to emit card.
                }

                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-start',
                    call,
                    name,
                    title,
                    description: title,
                    args,
                }, { turn: turnId, subagent, ...(taskCallId ? { taskCall: taskCallId } : {}) }));
                const buffered = consumeBufferedSubagentMessages(state, call);
                for (const bufferedMessage of buffered) {
                    const replay = mapClaudeLogMessageToSessionEnvelopesInternal(bufferedMessage, state);
                    envelopes.push(...replay.envelopes);
                }
            }
        }

        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'user') {
        const taskCallId = subagent ? getTaskCallBySubagent(state).get(subagent) : undefined;
        if (typeof message.message.content === 'string') {
            if (message.isSidechain) {
                // Don't emit the sub-agent prompt as a visible text bubble in the
                // main conversation.  The prompt is internal metadata for the
                // delegation — the user shouldn't see it as a standalone message.
                if (!isKnownTaskPrompt(state, message.message.content)) {
                    const turnId = ensureTurn(state, envelopes);
                    maybeEmitSubagentStart(state, turnId, subagent, envelopes);
                    envelopes.push(createEnvelope('agent', { t: 'text', text: message.message.content }, { turn: turnId, subagent, ...(taskCallId ? { taskCall: taskCallId } : {}) }));
                }
            } else if (message.isMeta || message.isSynthetic) {
                // isMeta: internal prompts (e.g. inbox turn notifications)
                // isSynthetic: SDK-injected prompts (e.g. Skill invocations)
                // Suppress these so they don't appear as standalone user bubbles.
            } else if ((state.suppressNextUserTextCount ?? 0) > 0) {
                // Suppress internal CLI-injected prompts (e.g. inbox turn notifications)
                // that were registered via suppressNextUserText() before the turn started.
                state.suppressNextUserTextCount = (state.suppressNextUserTextCount ?? 1) - 1;
            } else {
                closeTurn(state, 'completed', envelopes);
                envelopes.push(createEnvelope('user', { t: 'text', text: message.message.content }));
            }

            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        const blocks = Array.isArray(message.message.content) ? message.message.content : [];
        if (blocks.length === 0) {
            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        // Suppress meta / synthetic / CLI-injected user text prompts.
        // Only suppress user-type messages — sub-agent output
        // (assistant messages with tool_use blocks) must pass.
        const isUserText = message.type === 'user';
        if (message.isMeta || message.isSynthetic || (isUserText && (state.suppressNextUserTextCount ?? 0) > 0)) {
            if (!message.isMeta && !message.isSynthetic && isUserText) {
                state.suppressNextUserTextCount = (state.suppressNextUserTextCount ?? 1) - 1;
            }
            return { currentTurnId: state.currentTurnId, envelopes };
        }

        // Process tool_result blocks first (subagent stop, tool-call-end)
        // before closeTurn, which clears subagent tracking.
        const turnId = ensureTurn(state, envelopes);
        const isChain = isSidechainMessage(message);
        if (isChain) {
            maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        }
        for (const block of blocks) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0) {
                const bgTaskId = extractBackgroundTaskId(block, message);
                if (bgTaskId) {
                    ensureBgTaskIdToCallId(state).set(bgTaskId, block.tool_use_id);
                }
                // Parse TaskCreate results to extract the SDK-assigned task ID
                // (e.g. {"task":{"id":"1","subject":"Fix bug"}} → sdkTaskIdToCallId).
                if (state.taskCreateCallIds?.has(block.tool_use_id)) {
                    const taskInfo = parseTaskCreateResult(block.content);
                    if (taskInfo) {
                        ensureSdkTaskIdToCallId(state).set(taskInfo.id, block.tool_use_id);
                        state.taskCreateCallIds?.delete(block.tool_use_id);
                    }
                }
                const sessionSubagentForToolResult = getSessionSubagentIdForProviderSubagent(state, block.tool_use_id);
                if (!isChain) {
                    if (getHiddenParentToolCalls(state).has(block.tool_use_id)) {
                        if (sessionSubagentForToolResult) {
                            // Sub-agent output lives in the tool_result content.
                            // Extract readable result so the App's sidechain shows the summary.
                            const subagentResult = typeof block.content === 'string'
                                ? block.content
                                : Array.isArray(block.content)
                                    ? block.content.map((c: unknown) =>
                                        typeof c === 'object' && c !== null && 'text' in (c as object)
                                            ? (c as { text: string }).text : '').join('\n').trim()
                                    : undefined;
                            envelopes.push(createEnvelope('agent', {
                                t: 'tool-call-end',
                                call: block.tool_use_id,
                                ...(subagentResult ? { result: subagentResult } : {}),
                            }, { turn: turnId, subagent: sessionSubagentForToolResult,
                                ...(taskCallId ? { taskCall: taskCallId } : {}) }));
                            maybeEmitSubagentStop(state, turnId, sessionSubagentForToolResult, envelopes);
                        }
                        getHiddenParentToolCalls(state).delete(block.tool_use_id);
                        continue;
                    }
                    if (sessionSubagentForToolResult) {
                        maybeEmitSubagentStop(state, turnId, sessionSubagentForToolResult, envelopes);
                    }
                }
                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-end',
                    call: block.tool_use_id,
                    result: block.content,
                }, { turn: turnId, subagent, ...(taskCallId ? { taskCall: taskCallId } : {}) }));
                continue;
            }
        }

        // Sidechain text blocks (sub-agent prompts, internal delegations) should never
        // appear as standalone user bubbles in the main conversation.
        const textBlocks = blocks.filter(b => b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
        const userText = textBlocks.map(b => (b as { text: string }).text).join('\n');
        if (isChain) {
            // Suppress known task prompts; emit others as agent text so they link to the subagent.
            if (userText && !isKnownTaskPrompt(state, userText)) {
                envelopes.push(createEnvelope('agent', { t: 'text', text: userText }, { turn: turnId, subagent, ...(taskCallId ? { taskCall: taskCallId } : {}) }));
            }
        } else {
            // Close the old turn and emit user text as a user envelope
            closeTurn(state, 'completed', envelopes);
            if (userText) {
                envelopes.push(createEnvelope('user', { t: 'text', text: userText }));
            }
        }

        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    return {
        currentTurnId: state.currentTurnId,
        envelopes,
    };
}
