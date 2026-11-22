import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    type ClaudeSessionProtocolState,
} from './sessionProtocolMapper';

describe('mapClaudeLogMessageToSessionEnvelopes', () => {
    it('maps a goal_status sentinel attachment to a goal-status envelope', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'attachment',
            uuid: 'g-1',
            attachment: {
                type: 'goal_status',
                condition: 'user says done',
                met: false,
                sentinel: true,
            },
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('agent');
        expect(result.envelopes[0].ev).toEqual({
            t: 'goal-status',
            condition: 'user says done',
            met: false,
            sentinel: true,
            failed: undefined,
            reason: undefined,
            iterations: undefined,
            durationMs: undefined,
            tokens: undefined,
        });
    });

    it('maps a goal_status resolution attachment to a goal-status envelope', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'attachment',
            uuid: 'g-2',
            attachment: {
                type: 'goal_status',
                condition: 'user says done',
                met: true,
                reason: 'user said done',
                iterations: 3,
                durationMs: 1500,
                tokens: 42,
            },
        } as any, { currentTurnId: null });

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({
            t: 'goal-status',
            condition: 'user says done',
            met: true,
            sentinel: undefined,
            failed: undefined,
            reason: 'user said done',
            iterations: 3,
            durationMs: 1500,
            tokens: 42,
        });
    });

    it('ignores non-goal_status attachments', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'attachment',
            uuid: 'g-3',
            attachment: { type: 'something_else' },
        } as any, { currentTurnId: null });

        expect(result.envelopes).toHaveLength(0);
    });

    it('maps user text to a user text envelope', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-1',
            message: {
                role: 'user',
                content: 'hello from user',
            },
            timestamp: '2025-01-01T00:00:00.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('user');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'hello from user' });
    });

    it('keeps a synthetic peer message visible and strips Claude Code\'s framing', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-peer-1',
            isSynthetic: true,
            isReplay: true,
            origin: { kind: 'peer', from: 'happy-cli' },
            message: {
                role: 'user',
                content: 'Another Claude session sent a message:\nPlease run the tests.\n\n'
                    + 'This came from another Claude session — not typed by your user, but very likely working on their behalf.',
            },
        } as any, { currentTurnId: null });

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('user');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'Please run the tests.' });
        expect(result.envelopes[0]).toMatchObject({ origin: 'peer', peerFrom: 'happy-cli' });
    });

    it('keeps a peer message whose text has no Claude Code framing unchanged', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-peer-2',
            isSynthetic: true,
            origin: { kind: 'peer' },
            message: { role: 'user', content: 'plain peer body' },
        } as any, { currentTurnId: null });

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'plain peer body' });
        expect(result.envelopes[0]).toMatchObject({ origin: 'peer' });
        expect(result.envelopes[0]).not.toHaveProperty('peerFrom');
    });

    it('does not treat a synthetic message from anywhere else as a peer', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-synthetic-1',
            isSynthetic: true,
            origin: { kind: 'something-else' },
            message: { role: 'user', content: 'internal prompt' },
        } as any, { currentTurnId: null });

        expect(result.envelopes).toHaveLength(0);
    });

    it('starts a turn and maps assistant text blocks (thinking suppressed)', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'working...' },
                    { type: 'thinking', thinking: 'internal' },
                ],
            },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).not.toBeNull();
        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0].ev.t).toBe('turn-start');
        expect(result.envelopes[1].ev).toEqual({ t: 'text', text: 'working...' });
    });

    it('reports inference usage once per message id, on the envelope that carries content', () => {
        const state: ClaudeSessionProtocolState = { currentTurnId: null };
        const usage = {
            input_tokens: 142,
            cache_read_input_tokens: 128_384,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
        };
        const mapAssistant = (id: string, content: unknown[]) => mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: `u-${Math.random()}`,
            message: { role: 'assistant', id, model: 'glm-5.3', content, usage },
        } as any, state);

        // The first content block of a call carries the numbers.
        const first = mapAssistant('msg_1', [{ type: 'text', text: 'one' }]);
        expect(first.envelopes.find((e) => e.ev.t === 'text')?.usage).toEqual({
            input_tokens: 142,
            cache_read_input_tokens: 128_384,
            cache_creation_input_tokens: 0,
            model: 'glm-5.3',
        });

        // A second block of the same call repeats them — the App must not reprocess.
        const second = mapAssistant('msg_1', [{ type: 'text', text: 'two' }]);
        expect(second.envelopes.find((e) => e.ev.t === 'text')?.usage).toBeUndefined();

        // A thinking-only record produces no envelope, so it must not consume the report:
        // the call is still owed to the next visible block.
        const thinkingOnly = mapAssistant('msg_2', [{ type: 'thinking', thinking: 'internal' }]);
        expect(thinkingOnly.envelopes.some((e) => e.usage !== undefined)).toBe(false);
        const afterThinking = mapAssistant('msg_2', [{ type: 'text', text: 'visible' }]);
        expect(afterThinking.envelopes.find((e) => e.ev.t === 'text')?.usage?.input_tokens).toBe(142);

        // The next call reports again.
        const nextCall = mapAssistant('msg_3', [{ type: 'text', text: 'three' }]);
        expect(nextCall.envelopes.find((e) => e.ev.t === 'text')?.usage?.input_tokens).toBe(142);
    });

    it('never attaches usage to sidechain envelopes', () => {
        const mappedSubagent = createId();
        const state: ClaudeSessionProtocolState = {
            currentTurnId: null,
            providerSubagentToSessionSubagent: new Map<string, string>([['task-1', mappedSubagent]]),
        };

        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-usage',
            parent_tool_use_id: 'task-1',
            message: {
                role: 'assistant',
                id: 'msg_side',
                content: [{ type: 'text', text: 'sidechain text' }],
                usage: { input_tokens: 900, output_tokens: 0 },
            },
        } as any, state);

        expect(result.envelopes.every((e) => e.usage === undefined)).toBe(true);
    });

    it('maps tool use and tool result blocks to tool-call lifecycle', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-2',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
                ],
            },
        } as any, { currentTurnId: null });

        expect(started.envelopes.some((e) => e.ev.t === 'tool-call-start')).toBe(true);

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-2',
            message: {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.currentTurnId).toBe(started.currentTurnId);
        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ev: { t: 'tool-call-end', call: 'tool-1' },
                }),
            ]),
        );
    });

    it('uses parent_tool_use_id as subagent and emits subagent start', () => {
        const mappedSubagent = createId();
        const state = {
            currentTurnId: 'turn-1',
            providerSubagentToSessionSubagent: new Map<string, string>([['task-1', mappedSubagent]]),
        };

        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-1',
            parent_tool_use_id: 'task-1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'sidechain text' }],
            },
        } as any, state);

        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0].subagent).toBe(mappedSubagent);
        expect(result.envelopes[0].ev).toEqual({ t: 'start' });
        expect(result.envelopes[1].subagent).toBe(mappedSubagent);
        expect(result.envelopes[1].ev).toEqual({ t: 'text', text: 'sidechain text' });
    });

    it('does not read a main-thread message as a subagent through parentUuid', () => {
        // The SDK converter chains parentUuid across the whole stream, so a main-thread record
        // that follows a subagent record points at it. The subagent's card was from an earlier
        // turn, so its mapping no longer exists: inheriting here buffers the message (inside the
        // subagent) instead of emitting it, and the App never sees the reply.
        const state: ClaudeSessionProtocolState = {
            currentTurnId: 'turn-1',
            uuidToProviderSubagent: new Map<string, string>([['a-side-1', 'task-from-last-turn']]),
        };

        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-main-1',
            parentUuid: 'a-side-1',
            isSidechain: false,
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'the reply' }],
            },
        } as any, state);

        expect(result.envelopes).toEqual([
            expect.objectContaining({ ev: { t: 'text', text: 'the reply' } }),
        ]);
    });

    it('hides Task/Agent, shows Skill/TaskCreate/TaskUpdate/TaskOutput/TaskStop as cards', () => {
        const state = { currentTurnId: 'turn-active' };

        // These should be hidden
        for (const name of ['Task', 'Agent']) {
            const result = mapClaudeLogMessageToSessionEnvelopes({
                type: 'assistant',
                uuid: `a-${name}`,
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: `call-${name}`,
                        name,
                        input: name === 'Agent' ? { prompt: 'do work', description: 'Work' }
                             : { prompt: 'test', description: 'Test' },
                    }],
                },
            } as any, state);
            expect(result.envelopes.filter(e => e.ev.t === 'tool-call-start')).toHaveLength(0);
        }

        // These should emit tool-call-start (visible cards)
        for (const name of ['Skill', 'TaskCreate', 'TaskUpdate', 'TaskOutput', 'TaskStop']) {
            const result = mapClaudeLogMessageToSessionEnvelopes({
                type: 'assistant',
                uuid: `a-${name}`,
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: `call-${name}`,
                        name,
                        input: name === 'TaskCreate' ? { subject: 'Test', description: 'Test task' }
                             : name === 'TaskUpdate' ? { taskId: '1', status: 'in_progress' }
                             : name === 'Skill' ? { skill: 'test', args: '' }
                             : { task_id: 'bg123' },
                    }],
                },
            } as any, state);
            expect(result.envelopes.filter(e => e.ev.t === 'tool-call-start')).toHaveLength(1);
        }
    });

    it('hides Agent and remaps subagent children to TaskCreate card', () => {
        const state: any = {
            currentTurnId: 'turn-1',
            lastTaskCreateCallId: 'task-create-call-1',
        };

        // Agent should be hidden (no tool-call-start)
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'agent-call-1',
                    name: 'Agent',
                    input: { prompt: 'do work', description: 'Test agent' },
                }],
            },
        } as any, state);

        expect(result.envelopes.filter(e => e.ev.t === 'tool-call-start')).toHaveLength(0);

        // Subagent messages should get taskCall = TaskCreate's call ID
        const sessionSubagent = state.providerSubagentToSessionSubagent?.get('agent-call-1');
        expect(sessionSubagent).toBeDefined();
        expect(state.taskCallBySubagent?.get(sessionSubagent!)).toBe('task-create-call-1');
    });

    it('skips isMeta user messages (skill content injection)', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-meta-1',
            isMeta: true,
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Skill: loop instructions here...' }],
            },
        } as any, { currentTurnId: 'turn-1' });

        expect(result.currentTurnId).toBe('turn-1');
        expect(result.envelopes).toHaveLength(0);
    });

    it('hides Task tool_use in fixture logs', () => {
        const fixturePath = join(__dirname, '__fixtures__', 'task_non_sdk.jsonl');
        const rows = readFileSync(fixturePath, 'utf8')
            .trim()
            .split('\n')
            .slice(0, 6)
            .map((line) => JSON.parse(line));

        const state = { currentTurnId: null };
        const envelopes = rows.flatMap((row) => {
            return mapClaudeLogMessageToSessionEnvelopes(row as any, state).envelopes;
        });

        // Task tool_use should NOT appear as tool-call-start
        const taskCalls = envelopes.filter((envelope) => {
            return envelope.ev.t === 'tool-call-start' && envelope.ev.name === 'Task';
        });
        expect(taskCalls).toHaveLength(0);
    });

    it('emits stop for completed subagent when parent Task tool returns', () => {
        const mappedSubagent = createId();
        const state = {
            currentTurnId: 'turn-1',
            providerSubagentToSessionSubagent: new Map<string, string>([['task-2', mappedSubagent]]),
            hiddenParentToolCalls: new Set<string>(),
        };

        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-2',
            parent_tool_use_id: 'task-2',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'subagent running' }],
            },
        } as any, state);

        expect(started.envelopes.some((envelope) => {
            return envelope.ev.t === 'start' && envelope.subagent === mappedSubagent;
        })).toBe(true);

        const stopped = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-parent-2',
            isSidechain: false,
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'task-2', content: 'done' }],
            },
        } as any, state);

        expect(stopped.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    subagent: mappedSubagent,
                    ev: { t: 'stop' },
                }),
            ]),
        );
        expect(stopped.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-end'
                && envelope.ev.call === 'task-2';
        })).toBe(true);
    });

    it('drops the result fields the App never draws for an edit', () => {
        const state = { currentTurnId: null };
        // The tool_use names the call; the result carries only the id, so the name has to be kept
        // between the two envelopes for the result to be recognised.
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-edit',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/x', old_string: 'a', new_string: 'b' } }],
            },
        } as any, state);

        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-edit',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'ok' }],
            },
            toolUseResult: {
                filePath: '/x',
                oldString: 'a',
                newString: 'b',
                originalFile: 'x'.repeat(5000),
                replaceAll: false,
                structuredPatch: [{ hunks: [] }],
                userModified: false,
            },
        } as any, state);

        const end = result.envelopes.find((envelope) => envelope.ev.t === 'tool-call-end');
        // The diff the App draws is rebuilt from the arguments, so the provider's copies of it are
        // the larger half of the payload and travel nowhere.
        expect(end?.ev).toEqual({
            t: 'tool-call-end',
            call: 'edit-1',
            result: { filePath: '/x', replaceAll: false, userModified: false },
        });
    });

    it('leaves a result whole for a tool whose output the App shows', () => {
        const state = { currentTurnId: null };
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-bash',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } }],
            },
        } as any, state);

        const stdout = 'x'.repeat(5000);
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-bash',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'ok' }],
            },
            toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
        } as any, state);

        const end = result.envelopes.find((envelope) => envelope.ev.t === 'tool-call-end');
        expect((end?.ev as { result?: { stdout?: string } }).result?.stdout).toBe(stdout);
    });

    it('does not emit envelopes for summary messages', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'summary',
            summary: 'Done',
            leafUuid: 'leaf-1',
        } as any, { currentTurnId: 'turn-1' });

        expect(result.currentTurnId).toBe('turn-1');
        expect(result.envelopes).toHaveLength(0);
    });
});

describe('closeClaudeTurnWithStatus', () => {
    it('emits turn-end with provided status when turn is active', () => {
        const result = closeClaudeTurnWithStatus({ currentTurnId: 'turn-1' }, 'cancelled');
        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({ t: 'turn-end', status: 'cancelled' });
    });
});
