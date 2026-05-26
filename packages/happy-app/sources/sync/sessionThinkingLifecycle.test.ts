import { describe, expect, it } from 'vitest';
import {
    getSessionThinkingPatchFromMessageContent,
    isSessionTurnStartMessageContent,
} from './sessionThinkingLifecycle';

describe('getSessionThinkingPatchFromMessageContent', () => {
    it('clears thinking on cursor turn-end lifecycle envelope', () => {
        const patch = getSessionThinkingPatchFromMessageContent({
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: 'env-1',
                    time: 1,
                    role: 'agent',
                    ev: { t: 'turn-end', status: 'completed' },
                },
            },
        });
        expect(patch).toEqual({ thinking: false });
    });

    it('clears thinking on direct protocol turn-end (content.ev.t)', () => {
        const patch = getSessionThinkingPatchFromMessageContent({
            role: 'session',
            content: {
                id: 'env-2',
                time: 1,
                role: 'agent',
                ev: { t: 'turn-end', status: 'completed' },
            },
        });
        expect(patch).toEqual({ thinking: false });
    });

    it('sets thinking on turn-start', () => {
        const patch = getSessionThinkingPatchFromMessageContent({
            role: 'session',
            content: {
                type: 'session',
                data: { ev: { t: 'turn-start' } },
            },
        });
        expect(patch).toEqual({ thinking: true });
    });

    it('clears thinking on codex task_complete', () => {
        const patch = getSessionThinkingPatchFromMessageContent({
            role: 'agent',
            content: { type: 'codex', data: { type: 'task_complete', id: 't1' } },
        });
        expect(patch).toEqual({ thinking: false });
    });

    it('returns null for ordinary text', () => {
        expect(
            getSessionThinkingPatchFromMessageContent({
                role: 'user',
                content: { type: 'text', text: 'hi' },
            }),
        ).toBeNull();
    });

    it('sets thinking on flat session-protocol Summarizing service envelope', () => {
        const patch = getSessionThinkingPatchFromMessageContent({
            role: 'session',
            content: {
                id: 'env-2',
                role: 'agent',
                turn: 'turn-1',
                ev: { t: 'service', text: 'Summarizing...' },
            },
        });
        expect(patch).toEqual({ thinking: true });
    });

    it('sets thinking on tool-call-start when turn-start was missed', () => {
        const patch = getSessionThinkingPatchFromMessageContent({
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: 'env-tool',
                    role: 'agent',
                    ev: { t: 'tool-call-start', call: 'call-1', name: 'bash' },
                },
            },
        });
        expect(patch).toEqual({ thinking: true });
    });

    it('detects turn-start for ephemeral grace window', () => {
        expect(isSessionTurnStartMessageContent({
            role: 'session',
            content: { type: 'session', data: { ev: { t: 'turn-start' } } },
        })).toBe(true);
        expect(isSessionTurnStartMessageContent({
            role: 'session',
            content: { type: 'session', data: { ev: { t: 'tool-call-start', call: 'c1' } } },
        })).toBe(false);
    });
});
