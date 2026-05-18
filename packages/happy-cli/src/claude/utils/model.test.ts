import { describe, expect, it } from 'vitest';
import { normalizeClaudeModelForSdk } from './model';

describe('normalizeClaudeModelForSdk', () => {
    it('drops UI-only model selectors', () => {
        expect(normalizeClaudeModelForSdk('adaptiveUsage')).toBeUndefined();
        expect(normalizeClaudeModelForSdk('default')).toBeUndefined();
        expect(normalizeClaudeModelForSdk('auto')).toBeUndefined();
    });

    it('preserves concrete provider model names', () => {
        expect(normalizeClaudeModelForSdk('deepseek-v4-pro')).toBe('deepseek-v4-pro');
        expect(normalizeClaudeModelForSdk(' claude-sonnet-4-5 ')).toBe('claude-sonnet-4-5');
    });

    it('treats empty and nullish values as unset', () => {
        expect(normalizeClaudeModelForSdk(undefined)).toBeUndefined();
        expect(normalizeClaudeModelForSdk(null)).toBeUndefined();
        expect(normalizeClaudeModelForSdk('')).toBeUndefined();
        expect(normalizeClaudeModelForSdk('   ')).toBeUndefined();
    });
});
