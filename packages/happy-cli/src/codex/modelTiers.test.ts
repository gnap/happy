import { afterEach, describe, expect, it } from 'vitest';
import { codexModelOptions, currentTierCode, modelForTier, resolveCodexModel, resolveCodexModelIfExplicit, tierOfModel } from './modelTiers';

const saved = { ...process.env };

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('CODEX_MODEL') && saved[key] === undefined) {
            delete process.env[key];
        }
    }
    for (const key of Object.keys(saved)) {
        if (key.startsWith('CODEX_MODEL')) {
            process.env[key] = saved[key];
        }
    }
});

describe('resolveCodexModel', () => {
    it('maps a tier to its default build', () => {
        delete process.env.CODEX_MODEL_SOL;
        expect(resolveCodexModel('sol')).toBe('gpt-6.2-sol');
        expect(resolveCodexModel('astra')).toBe('gpt-6.2-astra');
        expect(resolveCodexModel('terra')).toBe('gpt-6.1-terra');
    });

    it('lets the machine decide the build behind a tier', () => {
        process.env.CODEX_MODEL_SOL = 'gpt-6.1-sol';
        process.env.CODEX_MODEL_ASTRA = 'gpt-6.3-astra';
        expect(resolveCodexModel('sol')).toBe('gpt-6.1-sol');
        expect(resolveCodexModel('astra')).toBe('gpt-6.3-astra');
    });

    it('maps the legacy effort-keyed names to tiers', () => {
        expect(resolveCodexModel('gpt-5-codex-high')).toBe(modelForTier('sol'));
        expect(resolveCodexModel('gpt-5-codex-medium')).toBe(modelForTier('terra'));
        expect(resolveCodexModel('gpt-5-codex-low')).toBe(modelForTier('luna'));
    });

    it('passes a real model slug through untouched', () => {
        expect(resolveCodexModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    });

    it('uses CODEX_MODEL for the default, tier or slug', () => {
        process.env.CODEX_MODEL = 'terra';
        expect(resolveCodexModel(undefined)).toBe(modelForTier('terra'));
        process.env.CODEX_MODEL = 'gpt-6.0-sol';
        expect(resolveCodexModel(undefined)).toBe('gpt-6.0-sol');
    });
});

describe('resolveCodexModelIfExplicit', () => {
    it('sends nothing when only a tier was picked and the machine maps no build', () => {
        delete process.env.CODEX_MODEL;
        delete process.env.CODEX_MODEL_SOL;
        expect(resolveCodexModelIfExplicit('sol')).toBeUndefined();
        expect(resolveCodexModelIfExplicit(undefined)).toBeUndefined();
    });

    it('sends a tier only when the machine maps it to a real model', () => {
        process.env.CODEX_MODEL_SOL = 'gpt-5-codex';
        expect(resolveCodexModelIfExplicit('sol')).toBe('gpt-5-codex');
        expect(resolveCodexModelIfExplicit('gpt-5-codex')).toBe('gpt-5-codex');
    });

    it('does not treat a tier name in CODEX_MODEL as a model', () => {
        process.env.CODEX_MODEL = 'terra';
        expect(resolveCodexModelIfExplicit('sol')).toBeUndefined();
        expect(resolveCodexModelIfExplicit(undefined)).toBeUndefined();
    });

    it('uses a real CODEX_MODEL as the default', () => {
        process.env.CODEX_MODEL = 'gpt-5-codex';
        expect(resolveCodexModelIfExplicit(undefined)).toBe('gpt-5-codex');
    });
});

describe('tierOfModel / currentTierCode', () => {
    it('names the tier a key stands for', () => {
        expect(tierOfModel('sol')).toBe('sol');
        expect(tierOfModel('gpt-5-codex-low')).toBe('luna');
        expect(tierOfModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
        expect(tierOfModel(null)).toBeUndefined();
    });

    it('publishes a tier key, falling back to the raw model or Sol', () => {
        delete process.env.CODEX_MODEL;
        expect(currentTierCode('terra')).toBe('terra');
        expect(currentTierCode('gpt-6.1-sol')).toBe('gpt-6.1-sol');
        expect(currentTierCode(undefined)).toBe('sol');
    });
});

describe('codexModelOptions', () => {
    it('offers stable tier keys with display names', () => {
        expect(codexModelOptions().map((option) => option.code)).toEqual(['sol', 'astra', 'terra', 'luna']);
        expect(codexModelOptions()[0]).toMatchObject({ code: 'sol', value: 'Sol' });
    });
});
