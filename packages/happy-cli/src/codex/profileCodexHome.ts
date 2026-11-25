/**
 * The Codex home a profile's endpoint or login is materialised into.
 *
 * Codex reads its provider and its credentials from `CODEX_HOME`, not from environment variables.
 * A person configuring a profile should not have to author `config.toml` or decide where the home
 * lives, so a profile states one of two things:
 *
 * - an endpoint (`baseUrl` / `apiKey` / `model`), which becomes a small provider entry, or
 * - a ChatGPT login (`auth.json` from a device-auth sign-in), which becomes `auth.json` here and
 *   leaves Codex on its built-in OpenAI provider.
 *
 * The endpoint key is *not* written to the file: the config names `CODEX_API_KEY` as the provider's
 * `env_key`, and the process already carries the value. The auth file is a credential and is
 * written with `0600`.
 *
 * An OAuth home is shared per account rather than per session, because Codex refreshes the access
 * token with the refresh token and rewrites `auth.json`; two copies of one login would race, and the
 * copy that refreshes second would be holding a token the first has already rotated. One file per
 * account on this machine keeps the refresh chain in one place, serialised by Codex's own lock.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProfileCodexAuth = {
    /** The `auth.json` body produced by `codex login`, verbatim. */
    authJson: string;
    /** When the sign-in happened, in epoch milliseconds. Newer beats a refreshed file on disk. */
    savedAt: number;
};

export type ProfileCodexConfig = {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    auth?: ProfileCodexAuth;
};

const PROVIDER_ID = 'happy-profile';

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/** Whether a string is an auth file Codex can use, not merely anything wearing the name. */
function isUsableAuth(value: string): boolean {
    try {
        const parsed = JSON.parse(value) as {
            tokens?: { access_token?: unknown; refresh_token?: unknown };
            OPENAI_API_KEY?: unknown;
        };
        return typeof parsed?.OPENAI_API_KEY === 'string'
            || (typeof parsed?.tokens?.access_token === 'string' && parsed.tokens.access_token.length > 0)
            || (typeof parsed?.tokens?.refresh_token === 'string' && parsed.tokens.refresh_token.length > 0);
    } catch {
        return false;
    }
}

function authAccountId(authJson: string): string | undefined {
    try {
        const parsed = JSON.parse(authJson) as {
            tokens?: { account_id?: unknown; access_token?: unknown };
        };
        if (typeof parsed?.tokens?.account_id === 'string' && parsed.tokens.account_id) {
            return parsed.tokens.account_id;
        }
        // Older shapes carry the account only in the access token's claims. Reading it keeps the
        // home stable across a re-login, which is what the refresh chain lives in.
        const access = parsed?.tokens?.access_token;
        if (typeof access !== 'string') return undefined;
        const encoded = access.split('.')[1];
        if (!encoded) return undefined;
        const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
            'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown };
        };
        const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
        return typeof account === 'string' && account ? account : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The login a profile put on the session process, if it carries one.
 *
 * The wire form is base64 so the value survives an environment record unchanged. A malformed value
 * is treated as absent rather than crashing the session; the profile editor is the only writer and
 * it validates what it stores.
 */
function readAuth(env: Record<string, string | undefined>): ProfileCodexAuth | undefined {
    const encoded = nonEmpty(env.CODEX_AUTH_JSON);
    if (!encoded) return undefined;
    let authJson: string;
    try {
        authJson = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
        return undefined;
    }
    if (!isUsableAuth(authJson)) return undefined;
    const savedAt = Number(env.CODEX_AUTH_SAVED_AT);
    return { authJson, savedAt: Number.isFinite(savedAt) ? savedAt : 0 };
}

/** The endpoint or login a profile put on the session process, if it named any part of one. */
export function readProfileCodexConfig(env: Record<string, string | undefined>): ProfileCodexConfig | null {
    const auth = readAuth(env);
    if (auth) {
        // A login is the stronger statement: it is the whole credential file. Leaving a base URL or
        // key alongside it would put Codex back on the profile provider and ignore the login.
        return { auth, ...(nonEmpty(env.CODEX_MODEL) ? { model: nonEmpty(env.CODEX_MODEL) } : {}) };
    }
    const config: ProfileCodexConfig = {
        baseUrl: nonEmpty(env.CODEX_BASE_URL),
        apiKey: nonEmpty(env.CODEX_API_KEY),
        model: nonEmpty(env.CODEX_MODEL),
    };
    return config.baseUrl || config.apiKey || config.model ? config : null;
}

/**
 * Where this session's managed home lives.
 *
 * The session tag is the one name a session has before the server answers, and it survives a
 * restart — which is what makes rewriting the config on the next process harmless.
 */
export function profileCodexHomeDir(happyHomeDir: string, sessionKey: string): string {
    const safe = sessionKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'session';
    return join(happyHomeDir, 'codex', safe);
}

/** Where a ChatGPT login lives: one home per account on this machine, not per session. */
export function profileCodexAuthHomeDir(happyHomeDir: string, authJson: string): string {
    const account = authAccountId(authJson);
    const key = account
        ? account.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
        : createHash('sha256').update(authJson).digest('hex').slice(0, 16);
    return join(happyHomeDir, 'codex', 'auth', key || 'account');
}

function tomlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The `config.toml` body. Exported so its exact shape can be asserted without touching disk. */
export function renderProfileCodexToml(config: ProfileCodexConfig): string {
    // A login is complete on its own: no provider may be named, or Codex would use the provider
    // and its env key instead of the auth file. The model is sent per turn, so nothing belongs in
    // the shared file (which two sessions on one account may open at the same time).
    if (config.auth) {
        return '';
    }
    const lines: string[] = [];
    if (config.model) {
        lines.push(`model = ${tomlString(config.model)}`);
    }
    if (config.baseUrl) {
        lines.push(
            `model_provider = "${PROVIDER_ID}"`,
            '',
            `[model_providers.${PROVIDER_ID}]`,
            'name = "Happy profile"',
            `base_url = ${tomlString(config.baseUrl)}`,
        );
        if (config.apiKey) {
            lines.push('env_key = "CODEX_API_KEY"');
        }
        lines.push('wire_api = "responses"');
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Writes the login into a shared home, unless the file there is already newer.
 *
 * Codex rewrites `auth.json` when it refreshes; overwriting that with the profile's older copy on
 * every start would throw away the rotated refresh token and break the next refresh. The profile's
 * copy wins only when this sign-in is newer than the file (a re-login), or when the file is missing
 * or unusable.
 */
function seedAuthFile(homeDir: string, auth: ProfileCodexAuth): void {
    const path = join(homeDir, 'auth.json');
    try {
        if (existsSync(path)) {
            const current = readFileSync(path, 'utf8');
            const fresh = statSync(path).mtimeMs >= auth.savedAt - 2_000;
            if (isUsableAuth(current) && fresh) return;
        }
    } catch {
        // An unreadable file is no better than a missing one.
    }
    writeFileSync(path, auth.authJson, { mode: 0o600 });
}

/** Writes the home and returns its path. The caller points `CODEX_HOME` at it. */
export function writeProfileCodexHome(happyHomeDir: string, sessionKey: string, config: ProfileCodexConfig): string {
    const homeDir = config.auth
        ? profileCodexAuthHomeDir(happyHomeDir, config.auth.authJson)
        : profileCodexHomeDir(happyHomeDir, sessionKey);
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    if (config.auth) {
        seedAuthFile(homeDir, config.auth);
    }
    writeFileSync(join(homeDir, 'config.toml'), renderProfileCodexToml(config), { mode: 0o600 });
    return homeDir;
}
