import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta, resolveMessageProfileEnv } from './messageMeta';
import type { AIBackendProfile } from './settings';

describe('resolveMessageModeMeta', () => {
    it('sends explicit permission and model keys', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'read-only',
            modelMode: 'gpt-5-high',
            metadata: null,
        } as any);

        expect(meta).toEqual({
            permissionMode: 'read-only',
            model: 'gpt-5-high',
        });
    });

    it('forces bypass permissions in sandbox when mode is default', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: { enabled: true },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'bypassPermissions',
            model: null,
        });
    });

    it('keeps default permissions when sandbox is disabled', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'default',
            metadata: {
                sandbox: null,
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'default',
            model: null,
        });
    });

    it('sends maxMode from local override or session metadata', () => {
        expect(resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            maxMode: true,
            metadata: { currentMaxMode: false },
        } as any)).toEqual({
            permissionMode: 'default',
            model: null,
            maxMode: true,
        });

        expect(resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            maxMode: undefined,
            metadata: { currentMaxMode: true },
        } as any)).toEqual({
            permissionMode: 'default',
            model: null,
            maxMode: true,
        });
    });
});

describe('resolveMessageProfileEnv', () => {
    const llmCenterProfile: AIBackendProfile = {
        id: 'llm-center-test',
        name: 'LLM Center',
        version: '1.0.0',
        environmentVariables: [
            { name: 'ANTHROPIC_BASE_URL', value: 'https://llm-center.example/llm' },
            { name: 'ANTHROPIC_AUTH_TOKEN', value: 'sk-test' },
            { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'CLAUDE_test' },
        ],
        compatibility: { claude: true, codex: true, cursor: true, gemini: true },
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
    };

    it('returns profile env when session has profileId', () => {
        const env = resolveMessageProfileEnv(
            { profileId: 'llm-center-test' },
            [llmCenterProfile],
        );
        expect(env).toEqual({
            ANTHROPIC_BASE_URL: 'https://llm-center.example/llm',
            ANTHROPIC_AUTH_TOKEN: 'sk-test',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'CLAUDE_test',
        });
    });

    it('returns undefined when no profile is selected', () => {
        expect(resolveMessageProfileEnv({ profileId: null }, [llmCenterProfile])).toBeUndefined();
        expect(resolveMessageProfileEnv({ profileId: undefined }, [llmCenterProfile])).toBeUndefined();
    });
});
