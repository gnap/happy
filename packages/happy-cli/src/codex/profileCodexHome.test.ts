import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    adoptCodexHomeContents,
    findCodexHomeForThread,
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
    const authJson = (token: string, account = 'acct-1') => JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: token, refresh_token: 'r', account_id: account },
    });

    it('keeps the session home and links its auth to the per-account file', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-codex-auth-'));
        const home = writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('one'), savedAt: Date.now() } });
        expect(home).toBe(join(root, 'codex', 'tag'));
        expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('');
        expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('"one"');
        expect(readlinkSync(join(home, 'auth.json'))).toBe(join(root, 'codex', 'auth', 'acct-1', 'auth.json'));
    });

    it('keeps a refreshed account file unless the profile has a newer sign-in', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-codex-auth-'));
        const first = Date.now();
        const home = writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('one'), savedAt: first } });
        // Codex refreshed and rewrote the file; the profile's copy is now stale. It writes through
        // the link, so the account's canonical file is the one that moved.
        writeFileSync(join(home, 'auth.json'), authJson('refreshed'));
        expect(writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('one'), savedAt: first } })).toBe(home);
        expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('refreshed');
        // A fresh sign-in is newer than the file and must replace it.
        writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('two'), savedAt: Date.now() + 5_000 } });
        expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('two');
    });

    it('switches only the account: the home and its session data stay', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-codex-auth-'));
        const first = writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('one', 'acct-1'), savedAt: 1_000 } });
        // Something Codex wrote into the session home, e.g. a thread rollout.
        mkdirSync(join(first, 'sessions', '2026', '11', '27'), { recursive: true });
        writeFileSync(join(first, 'sessions', '2026', '11', '27', 'rollout-thread.jsonl'), '{}');

        const second = writeProfileCodexHome(root, 'tag', { auth: { authJson: authJson('two', 'acct-2'), savedAt: 2_000 } });
        expect(second).toBe(first);
        expect(readFileSync(join(second, 'sessions', '2026', '11', '27', 'rollout-thread.jsonl'), 'utf8')).toBe('{}');
        expect(readlinkSync(join(second, 'auth.json'))).toBe(join(root, 'codex', 'auth', 'acct-2', 'auth.json'));
    });
});

describe('adopting an older Codex home', () => {
    it('copies session-owned entries without overwriting or carrying the credential', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-codex-adopt-'));
        const source = join(root, 'old');
        const target = join(root, 'new');
        mkdirSync(join(source, 'sessions', '2026'), { recursive: true });
        mkdirSync(join(source, 'plugins'), { recursive: true });
        writeFileSync(join(source, 'sessions', '2026', 'rollout-thread.jsonl'), 'old');
        writeFileSync(join(source, 'plugins', 'plugin.txt'), 'plugin');
        writeFileSync(join(source, 'auth.json'), '{"tokens":{}}');
        mkdirSync(join(target, 'sessions', '2026'), { recursive: true });
        writeFileSync(join(target, 'sessions', '2026', 'rollout-thread.jsonl'), 'new');

        adoptCodexHomeContents(target, source);

        expect(readFileSync(join(target, 'sessions', '2026', 'rollout-thread.jsonl'), 'utf8')).toBe('new');
        expect(readFileSync(join(target, 'plugins', 'plugin.txt'), 'utf8')).toBe('plugin');
        expect(existsSync(join(target, 'auth.json'))).toBe(false);
    });

    it('finds the old home that owns a thread rollout', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-codex-find-'));
        const home = join(root, 'codex', 'auth', 'acct-1');
        mkdirSync(join(home, 'sessions', '2026', '11', '27'), { recursive: true });
        writeFileSync(
            join(home, 'sessions', '2026', '11', '27', 'rollout-2026-11-27T10-00-00-01a211fb.jsonl'),
            '{}',
        );
        expect(findCodexHomeForThread(root, '01a211fb')).toBe(home);
        expect(findCodexHomeForThread(root, 'missing')).toBeNull();
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
