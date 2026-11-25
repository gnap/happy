import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('readProfileCodexConfig with a login', () => {
    const authJson = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a', refresh_token: 'r', account_id: 'acct-1' } });
    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');

    it('decodes the login and lets it win over an endpoint', () => {
        expect(readProfileCodexConfig({
            CODEX_AUTH_JSON: encode(authJson),
            CODEX_AUTH_SAVED_AT: '1234',
            CODEX_BASE_URL: 'https://llm.example/v1',
            CODEX_API_KEY: 'sk-test',
            CODEX_MODEL: 'gpt-6.1-terra',
        })).toEqual({
            auth: { authJson, savedAt: 1234 },
            model: 'gpt-6.1-terra',
        });
    });

    it('ignores a value that is not a usable auth file', () => {
        expect(readProfileCodexConfig({ CODEX_AUTH_JSON: encode('{"nope":true}') })).toBeNull();
        expect(readProfileCodexConfig({ CODEX_AUTH_JSON: 'not base64!' })).toBeNull();
    });
});

describe('renderProfileCodexToml with a login', () => {
    it('writes no provider — the auth file is the whole credential', () => {
        const toml = renderProfileCodexToml({
            auth: { authJson: '{}', savedAt: 1 },
            baseUrl: 'https://llm.example/v1',
            model: 'gpt-6.1-terra',
        });
        expect(toml).toBe('');
    });
});

describe('writeProfileCodexHome with a login', () => {
    const authJson = (token: string) => JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: token, refresh_token: 'r', account_id: 'acct-1' },
    });

    it('writes the auth file under a per-account home and no provider', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-codex-auth-'));
        const home = writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('one'), savedAt: Date.now() } });
        expect(home).toBe(join(root, 'codex', 'auth', 'acct-1'));
        expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('');
        expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('"one"');
    });

    it('keeps a refreshed file unless the profile has a newer sign-in', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-codex-auth-'));
        const first = Date.now();
        const home = writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('one'), savedAt: first } });
        // Codex refreshed and rewrote the file; the profile's copy is now stale.
        writeFileSync(join(home, 'auth.json'), authJson('refreshed'));
        expect(writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('one'), savedAt: first } })).toBe(home);
        expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('refreshed');
        // A fresh sign-in is newer than the file and must replace it.
        writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('two'), savedAt: Date.now() + 5_000 } });
        expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('two');
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
