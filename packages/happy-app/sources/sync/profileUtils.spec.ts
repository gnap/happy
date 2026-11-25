import { describe, expect, it } from 'vitest';
import { agentChoiceOf, compatibilityForAgent } from './profileUtils';
import { validateProfileForAgent, type AIBackendProfile } from './settings';

const allAgents = { claude: true, codex: true, cursor: true, gemini: true };

function profile(overrides: Partial<AIBackendProfile> = {}): AIBackendProfile {
    return {
        id: 'profile',
        name: 'Profile',
        environmentVariables: [],
        compatibility: allAgents,
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
        ...overrides,
    } as AIBackendProfile;
}

describe('compatibilityForAgent', () => {
    it('names exactly one agent, whichever it is', () => {
        for (const agent of ['claude', 'codex', 'cursor', 'gemini'] as const) {
            const compatibility = compatibilityForAgent(agent);
            expect(Object.values(compatibility).filter(Boolean)).toHaveLength(1);
            expect(validateProfileForAgent(profile({ compatibility }), agent)).toBe(true);
        }
    });

    it('covers cursor-acp with the cursor choice', () => {
        const compatibility = compatibilityForAgent('cursor');
        expect(validateProfileForAgent(profile({ compatibility }), 'cursor-acp')).toBe(true);
        expect(validateProfileForAgent(profile({ compatibility }), 'claude')).toBe(false);
    });
});

describe('legacy multi-agent profiles', () => {
    it('reads an Anthropic environment as a Claude profile', () => {
        const legacy = profile({
            environmentVariables: [
                { name: 'ANTHROPIC_BASE_URL', value: 'https://llm.example/anthropic' },
                { name: 'ANTHROPIC_AUTH_TOKEN', value: 'sk-test' },
            ],
        });
        expect(validateProfileForAgent(legacy, 'claude')).toBe(true);
        expect(validateProfileForAgent(legacy, 'codex')).toBe(false);
    });

    it('reads a Codex endpoint as a Codex profile', () => {
        const legacy = profile({
            codexConfig: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test' },
        });
        expect(validateProfileForAgent(legacy, 'codex')).toBe(true);
        expect(validateProfileForAgent(legacy, 'claude')).toBe(false);
    });

    it('reads CODEX_/OPENAI_ variables as a Codex profile', () => {
        const legacy = profile({
            environmentVariables: [{ name: 'CODEX_HOME', value: '/tmp/codex' }],
        });
        expect(validateProfileForAgent(legacy, 'codex')).toBe(true);
        expect(validateProfileForAgent(legacy, 'gemini')).toBe(false);
    });

    it('leaves built-in profiles on their declared map', () => {
        const builtIn = profile({
            isBuiltIn: true,
            compatibility: { claude: true, codex: false, cursor: true, gemini: false },
            environmentVariables: [{ name: 'ANTHROPIC_BASE_URL', value: 'https://llm.example/anthropic' }],
        });
        expect(validateProfileForAgent(builtIn, 'cursor')).toBe(true);
        expect(validateProfileForAgent(builtIn, 'claude')).toBe(true);
        expect(validateProfileForAgent(builtIn, 'gemini')).toBe(false);
    });
});

describe('agentChoiceOf', () => {
    it('reads the only enabled agent back', () => {
        expect(agentChoiceOf(profile({ compatibility: compatibilityForAgent('codex') }))).toBe('codex');
        expect(agentChoiceOf(profile({ compatibility: compatibilityForAgent('gemini') }))).toBe('gemini');
    });

    it('opens a legacy multi-agent profile on the agent its environment names', () => {
        expect(agentChoiceOf(profile({
            environmentVariables: [{ name: 'ANTHROPIC_BASE_URL', value: 'https://llm.example/anthropic' }],
        }))).toBe('claude');
        expect(agentChoiceOf(profile({
            codexConfig: { baseUrl: 'https://llm.example/v1' },
        }))).toBe('codex');
    });

    it('falls back to claude for a profile with no signal rather than leaving the editor blank', () => {
        expect(agentChoiceOf(profile({
            compatibility: { claude: false, codex: false, cursor: false, gemini: false },
        }))).toBe('claude');
    });
});
