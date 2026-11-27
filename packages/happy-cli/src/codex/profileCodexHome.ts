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
 * A session's home is keyed by the session tag and stays the same across profile and account
 * changes: threads, plugins, skills and the rest of Codex's state live there. The login is the one
 * thing that changes, so it is linked from a per-account auth file; Codex's refresh writes through
 * the link and the account's refresh chain stays in one place. Switching profiles must not move the
 * session to a different home, or its thread rollout — which is the conversation — is left behind.
 */

import { createHash } from 'node:crypto';
import {
    copyFileSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

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

/**
 * Where a ChatGPT login's canonical `auth.json` lives: one per account on this machine.
 *
 * This is no longer a `CODEX_HOME`; a session home links its `auth.json` here. One file per
 * account keeps Codex's refresh chain in one place even when several sessions use the account.
 */
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

/** Replaces `linkPath` with a link to `target`, falling back to a copy where links are unavailable. */
function linkAuthFile(target: string, linkPath: string): void {
    try {
        const current = lstatSync(linkPath);
        if (current.isSymbolicLink() && readlinkSync(linkPath) === target) return;
    } catch {
        // Missing, dangling, or unreadable: replace it.
    }
    try {
        rmSync(linkPath, { force: true });
    } catch {
        // A directory here is a corrupt home; let the write below fail loudly.
    }
    try {
        symlinkSync(target, linkPath);
    } catch {
        // Windows without symlink privileges: a copy still gives Codex a usable auth file. The
        // per-account file remains canonical, and the newer-wins seed on the next write reconciles.
        copyFileSync(target, linkPath);
    }
}

/** The parts of a Codex home that belong to the session, not to the account. */
const SESSION_HOME_ENTRIES = ['sessions', 'plugins', 'skills'] as const;

/**
 * Copies the session-owned entries from an older home into the stable one, without overwriting
 * what is already there.
 *
 * This is a one-time migration for sessions that predate the stable per-session home: their
 * thread rollout (and the plugins/skills Codex installed) live under the old account home. The
 * account credential is deliberately not copied — the selected profile owns that.
 */
export function adoptCodexHomeContents(targetHome: string, sourceHome: string): void {
    if (resolve(targetHome) === resolve(sourceHome)) return;
    mkdirSync(targetHome, { recursive: true, mode: 0o700 });
    for (const entry of SESSION_HOME_ENTRIES) {
        const source = join(sourceHome, entry);
        if (!existsSync(source)) continue;
        try {
            cpSync(source, join(targetHome, entry), { recursive: true, force: false, errorOnExist: false });
        } catch {
            // Best effort: a home that cannot be copied must not keep the session from starting.
        }
    }
}

/** Whether a home's `sessions` tree contains a rollout for this thread. */
function homeHasThread(home: string, threadId: string): boolean {
    const sessions = join(home, 'sessions');
    if (!existsSync(sessions)) return false;
    const suffix = `-${threadId}.jsonl`;
    const walk = (dir: string, depth: number): boolean => {
        if (depth > 4) return false;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return false;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (walk(path, depth + 1)) return true;
            } else if (entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
                return true;
            }
        }
        return false;
    };
    return walk(sessions, 0);
}

/**
 * The old home a session's stored thread lives in, when it predates the stable per-session home.
 *
 * Searches the per-account auth stores and any other managed homes; null means nothing on this
 * machine owns the rollout. Used once, at startup, to seed the stable home before Codex resumes.
 */
export function findCodexHomeForThread(happyHomeDir: string, threadId: string): string | null {
    const root = join(happyHomeDir, 'codex');
    if (!existsSync(root)) return null;
    const candidates: string[] = [];
    const authRoot = join(root, 'auth');
    if (existsSync(authRoot)) {
        for (const name of readdirSync(authRoot)) candidates.push(join(authRoot, name));
    }
    for (const name of readdirSync(root)) {
        if (name === 'auth') continue;
        const path = join(root, name);
        try {
            if (lstatSync(path).isDirectory()) candidates.push(path);
        } catch {
            // A race with cleanup is not a home.
        }
    }
    for (const home of candidates) {
        if (homeHasThread(home, threadId)) return home;
    }
    return null;
}

/**
 * Writes the session's home and returns its path. The caller points `CODEX_HOME` at it.
 *
 * The home is always keyed by the session tag, whatever the profile selects. The login is the
 * only part that moves: its canonical file stays per account and `auth.json` in the home links to
 * it. That is what keeps a thread (and the plugins/skills under the same home) across a profile
 * or account switch.
 */
export function writeProfileCodexHome(happyHomeDir: string, sessionKey: string, config: ProfileCodexConfig): string {
    const homeDir = profileCodexHomeDir(happyHomeDir, sessionKey);
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    if (config.auth) {
        const authHome = profileCodexAuthHomeDir(happyHomeDir, config.auth.authJson);
        mkdirSync(authHome, { recursive: true, mode: 0o700 });
        seedAuthFile(authHome, config.auth);
        linkAuthFile(join(authHome, 'auth.json'), join(homeDir, 'auth.json'));
    } else {
        // A session moving from a login to an endpoint must not keep the previous login: Codex
        // would read it and ignore the provider the profile just named.
        try {
            rmSync(join(homeDir, 'auth.json'), { force: true });
        } catch {
            // Nothing to remove, or a directory we should not touch.
        }
    }
    writeFileSync(join(homeDir, 'config.toml'), renderProfileCodexToml(config), { mode: 0o600 });
    return homeDir;
}
