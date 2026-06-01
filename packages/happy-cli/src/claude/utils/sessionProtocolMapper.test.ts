import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
} from './sessionProtocolMapper';

describe('mapClaudeLogMessageToSessionEnvelopes', () => {
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

    it('starts a turn and maps assistant text blocks, suppressing thinking', () => {
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

        // closeTurn nullifies currentTurnId; tool-call-end still emitted
        expect(ended.currentTurnId).toBeNull();
        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ ev: { t: 'turn-end', status: 'completed' } }),
                expect.objectContaining({ ev: { t: 'tool-call-end', call: 'tool-1' } }),
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
