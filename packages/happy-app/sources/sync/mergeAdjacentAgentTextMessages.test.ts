import { describe, expect, it } from 'vitest';
import { mergeAdjacentAgentTextMessages } from './mergeAdjacentAgentTextMessages';
import type { Message } from './typesMessage';

describe('mergeAdjacentAgentTextMessages', () => {
    it('merges consecutive agent-text in chronological order', () => {
        const messages: Message[] = [
            { kind: 'agent-text', id: 'a', localId: null, createdAt: 2, text: 'second flush' },
            { kind: 'agent-text', id: 'b', localId: null, createdAt: 1, text: 'first flush' },
        ];
        const merged = mergeAdjacentAgentTextMessages(messages);
        expect(merged).toHaveLength(1);
        expect(merged[0]?.kind).toBe('agent-text');
        if (merged[0]?.kind !== 'agent-text') throw new Error('expected agent-text');
        expect(merged[0].text).toBe('first flush second flush');
        expect(merged[0].id).toBe('b');
    });

    it('does not merge across a user message', () => {
        const messages: Message[] = [
            { kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'A' },
            { kind: 'user-text', id: 'u', localId: null, createdAt: 2, text: 'hi' },
            { kind: 'agent-text', id: 'b', localId: null, createdAt: 3, text: 'B' },
        ];
        expect(mergeAdjacentAgentTextMessages(messages)).toHaveLength(3);
    });

    it('does not merge thinking bubbles', () => {
        const messages: Message[] = [
            { kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'out', isThinking: true },
            { kind: 'agent-text', id: 'b', localId: null, createdAt: 2, text: 'out2' },
        ];
        expect(mergeAdjacentAgentTextMessages(messages)).toHaveLength(2);
    });

    it('joins alphanumeric chunk boundaries with a space', () => {
        const messages: Message[] = [
            { kind: 'agent-text', id: 'b', localId: null, createdAt: 2, text: 'world' },
            { kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'hello' },
        ];
        const merged = mergeAdjacentAgentTextMessages(messages);
        expect(merged[0]?.kind).toBe('agent-text');
        if (merged[0]?.kind !== 'agent-text') throw new Error('expected agent-text');
        expect(merged[0].text).toBe('hello world');
    });

    it('uses a line break (not a space) between chunks that look like separate lines', () => {
        const messages: Message[] = [
            { kind: 'agent-text', id: 'b', localId: null, createdAt: 2, text: 'Line two' },
            { kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'Line one' },
        ];
        const merged = mergeAdjacentAgentTextMessages(messages);
        expect(merged[0]?.kind).toBe('agent-text');
        if (merged[0]?.kind !== 'agent-text') throw new Error('expected agent-text');
        expect(merged[0].text).toBe('Line one\nLine two');
    });
});
