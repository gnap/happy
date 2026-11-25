/**
 * A Codex home that belongs to a session, written from the endpoint a profile states.
 *
 * Codex reads its provider from `config.toml` inside `CODEX_HOME`, not from environment
 * variables. A person configuring a profile should not have to author that file or decide where
 * it lives, so a profile states only `baseUrl` / `apiKey` / `model`; this module turns those into
 * a small home under Happy's own directory (`<happyHomeDir>/codex/<session>`), which is where the
 * daemon already keeps everything else it owns.
 *
 * The key is *not* written to the file: the config names `CODEX_API_KEY` as the provider's
 * `env_key`, and the process already carries the value. The file holds the endpoint and, at most,
 * the model.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProfileCodexConfig = {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
};

const PROVIDER_ID = 'happy-profile';

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/** The endpoint a profile put on the session process, if it named any part of one. */
export function readProfileCodexConfig(env: Record<string, string | undefined>): ProfileCodexConfig | null {
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

function tomlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The `config.toml` body. Exported so its exact shape can be asserted without touching disk. */
export function renderProfileCodexToml(config: ProfileCodexConfig): string {
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

/** Writes the home and returns its path. The caller points `CODEX_HOME` at it. */
export function writeProfileCodexHome(happyHomeDir: string, sessionKey: string, config: ProfileCodexConfig): string {
    const homeDir = profileCodexHomeDir(happyHomeDir, sessionKey);
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(homeDir, 'config.toml'), renderProfileCodexToml(config), { mode: 0o600 });
    return homeDir;
}
