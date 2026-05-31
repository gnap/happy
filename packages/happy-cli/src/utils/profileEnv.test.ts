import { describe, expect, it } from 'vitest';
import { applyProfileEnvToProcess, mergeProfileIntoEnv, stripProfileManagedEnv } from './profileEnv';

describe('profileEnv', () => {
    it('stripProfileManagedEnv removes ANTHROPIC_* and CLAUDE_CODE_* only', () => {
        const result = stripProfileManagedEnv({
            PATH: '/bin',
            ANTHROPIC_MODEL: 'deepseek',
            ANTHROPIC_BASE_URL: 'https://deepseek.example',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
            HAPPY_HOME_DIR: '/home/user/.happy',
        });
        expect(result).toEqual({
            PATH: '/bin',
            HAPPY_HOME_DIR: '/home/user/.happy',
        });
    });

    it('mergeProfileIntoEnv replaces managed keys from profile', () => {
        const result = mergeProfileIntoEnv(
            {
                ANTHROPIC_MODEL: 'deepseek-v4-pro',
                ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
                PATH: '/bin',
            },
            {
                ANTHROPIC_BASE_URL: 'https://llm-center.example/llm',
                ANTHROPIC_AUTH_TOKEN: 'sk-profile',
                ANTHROPIC_DEFAULT_OPUS_MODEL: 'CLAUDE_test',
            },
        );
        expect(result.ANTHROPIC_MODEL).toBeUndefined();
        expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
        expect(result.ANTHROPIC_BASE_URL).toBe('https://llm-center.example/llm');
        expect(result.ANTHROPIC_AUTH_TOKEN).toBe('sk-profile');
        expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('CLAUDE_test');
        expect(result.PATH).toBe('/bin');
    });

    it('applyProfileEnvToProcess clears stale managed keys', () => {
        const prevModel = process.env.ANTHROPIC_MODEL;
        const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
        const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
        try {
            process.env.ANTHROPIC_MODEL = 'deepseek-v4-pro';
            process.env.ANTHROPIC_BASE_URL = 'https://deepseek.example';
            applyProfileEnvToProcess({
                ANTHROPIC_BASE_URL: 'https://llm-center.example/llm',
                ANTHROPIC_AUTH_TOKEN: 'sk-profile',
            });
            expect(process.env.ANTHROPIC_MODEL).toBeUndefined();
            expect(process.env.ANTHROPIC_BASE_URL).toBe('https://llm-center.example/llm');
            expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-profile');
        } finally {
            if (prevModel === undefined) delete process.env.ANTHROPIC_MODEL;
            else process.env.ANTHROPIC_MODEL = prevModel;
            if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
            else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
            if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
            else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
        }
    });
});
