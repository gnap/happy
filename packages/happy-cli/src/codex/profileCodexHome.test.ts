import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    profileCodexHomeDir,
    readProfileCodexConfig,
    renderProfileCodexToml,
    writeProfileCodexHome,
} from './profileCodexHome';

describe('readProfileCodexConfig', () => {
    it('returns null when the session carries no endpoint', () => {
        expect(readProfileCodexConfig({})).toBeNull();
        expect(readProfileCodexConfig({ CODEX_BASE_URL: '  ', CODEX_API_KEY: '' })).toBeNull();
    });

    it('trims the parts the profile named', () => {
        expect(readProfileCodexConfig({
            CODEX_BASE_URL: ' https://llm.example/v1 ',
            CODEX_API_KEY: ' sk-test ',
            CODEX_MODEL: ' gpt-6.1-terra ',
        })).toEqual({
            baseUrl: 'https://llm.example/v1',
            apiKey: 'sk-test',
            model: 'gpt-6.1-terra',
        });
    });
});

describe('renderProfileCodexToml', () => {
    it('names a custom provider and its env key, never the key itself', () => {
        const toml = renderProfileCodexToml({
            baseUrl: 'https://llm.example/v1',
            apiKey: 'sk-secret',
            model: 'gpt-6.1-terra',
        });
        expect(toml).toContain('model = "gpt-6.1-terra"');
        expect(toml).toContain('model_provider = "happy-profile"');
        expect(toml).toContain('base_url = "https://llm.example/v1"');
        expect(toml).toContain('env_key = "CODEX_API_KEY"');
        expect(toml).toContain('wire_api = "responses"');
        expect(toml).not.toContain('sk-secret');
    });

    it('writes a model-only config when the profile names no endpoint', () => {
        const toml = renderProfileCodexToml({ model: 'gpt-6.1-terra' });
        expect(toml).toContain('model = "gpt-6.1-terra"');
        expect(toml).not.toContain('model_provider');
    });

    it('omits env_key when the profile names no key', () => {
        const toml = renderProfileCodexToml({ baseUrl: 'http://localhost:11434/v1' });
        expect(toml).toContain('base_url = "http://localhost:11434/v1"');
        expect(toml).not.toContain('env_key');
    });
});

describe('writeProfileCodexHome', () => {
    it('writes the config under Happy’s own codex directory, keyed by the session tag', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-codex-'));
        const home = writeProfileCodexHome(root, 'tag/with weird chars', {
            baseUrl: 'https://llm.example/v1',
            apiKey: 'sk-test',
        });
        expect(home).toBe(join(root, 'codex', 'tag_with_weird_chars'));
        expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('base_url = "https://llm.example/v1"');
    });

    it('names a directory for a session key that sanitizes to nothing', () => {
        expect(profileCodexHomeDir('/home/me/.happy', '///')).toBe('/home/me/.happy/codex/___');
    });
});
