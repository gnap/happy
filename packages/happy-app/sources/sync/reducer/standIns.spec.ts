import { describe, expect, it } from 'vitest';
import { Message, ToolCall } from '@/sync/typesMessage';
import { dropStandInsOutsideWindow, isPermissionStandIn, visibleWindow } from './standIns';

function toolMessage(id: string, createdAt: number, overrides: Partial<ToolCall> = {}): Message {
    return {
        id,
        localId: null,
        kind: 'tool-call',
        createdAt,
        tool: {
            name: 'AskUserQuestion',
            state: 'completed',
            input: null,
            createdAt,
            startedAt: null,
            completedAt: createdAt,
            description: null,
            ...overrides,
        },
        children: [],
        meta: undefined,
    } as Message;
}

function textMessage(id: string, createdAt: number): Message {
    return { id, localId: null, kind: 'agent-text', createdAt, text: 'hi', meta: undefined } as Message;
}

describe('isPermissionStandIn', () => {
    it('recognizes a finished message that no tool call ever adopted', () => {
        expect(isPermissionStandIn(toolMessage('a', 100))).toBe(true);
    });

    it('does not treat a real tool call as a stand-in', () => {
        expect(isPermissionStandIn(toolMessage('a', 100, { startedAt: 120 }))).toBe(false);
    });

    it('does not treat a pending question as a stand-in', () => {
        expect(isPermissionStandIn(toolMessage('a', 100, { state: 'running' }))).toBe(false);
    });

    it('ignores messages that are not tool calls', () => {
        expect(isPermissionStandIn(textMessage('a', 100))).toBe(false);
    });
});

describe('dropStandInsOutsideWindow', () => {
    it('drops a finished stand-in older than the oldest real message', () => {
        const messages = [textMessage('real', 1_000), toolMessage('old', 500)];
        expect(dropStandInsOutsideWindow(messages).map(m => m.id)).toEqual(['real']);
    });

    it('keeps a finished stand-in that falls inside the loaded window', () => {
        const messages = [textMessage('real', 1_000), toolMessage('inside', 1_500)];
        expect(dropStandInsOutsideWindow(messages).map(m => m.id)).toEqual(['real', 'inside']);
    });

    it('keeps pending stand-ins however old they are — they are the question itself', () => {
        const messages = [textMessage('real', 1_000), toolMessage('pending', 500, { state: 'running' })];
        expect(dropStandInsOutsideWindow(messages).map(m => m.id)).toEqual(['real', 'pending']);
    });

    it('keeps everything when no real message has loaded yet', () => {
        const messages = [toolMessage('stand-in', 500)];
        expect(dropStandInsOutsideWindow(messages)).toEqual(messages);
    });
});

describe('visibleWindow', () => {
    it('builds the map from the visible messages only', () => {
        const window = visibleWindow([textMessage('real', 1_000), toolMessage('old', 500)]);
        expect(window.messages.map(m => m.id)).toEqual(['real']);
        expect(Object.keys(window.messagesMap)).toEqual(['real']);
    });
});
