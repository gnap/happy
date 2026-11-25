/**
 * The desktop app's Codex sign-in, as a few typed calls into the Tauri side.
 *
 * The Rust side owns the whole exchange: it resolves the profile's route to the loopback proxy the
 * daemon serves, starts `codex login --device-auth` in an isolated `CODEX_HOME` with that proxy in
 * its environment, and opens the sign-in page in a webview configured with the same proxy. This
 * module only carries the values between that flow and the profile editor.
 */
import { invoke } from '@tauri-apps/api/core';

export type CodexLoginPreflight = {
    ok: boolean;
    proxyUrl?: string;
    error?: string;
};

export type CodexLoginStarted = {
    /** The provider's verification page. */
    url: string;
    /** The code the page asks for, when the CLI printed one. */
    code?: string;
    /** The loopback route proxy both the CLI and the page must use. */
    proxyUrl?: string;
};

export type CodexLoginResult = {
    /** The `auth.json` body. Never log it. */
    authJson: string;
    savedAt: number;
};

/**
 * Proves the flow can run before anything is opened: the Codex CLI exists, and the selected route
 * is served by this machine and answering on its port. A failure here is the only thing that keeps
 * a sign-in from mixing egress addresses.
 */
export async function codexLoginPreflight(route: string): Promise<CodexLoginPreflight> {
    return invoke<CodexLoginPreflight>('codex_login_preflight', { route });
}

export async function codexLoginStart(route: string): Promise<CodexLoginStarted> {
    return invoke<CodexLoginStarted>('codex_login_start', { route });
}

/** Resolves when the CLI has the tokens; rejects on denial, expiry or process failure. */
export async function codexLoginFinish(): Promise<CodexLoginResult> {
    return invoke<CodexLoginResult>('codex_login_finish');
}

export async function codexLoginCancel(): Promise<void> {
    await invoke('codex_login_cancel');
}

export async function codexLoginOpenWindow(url: string, proxyUrl?: string, code?: string): Promise<void> {
    await invoke('codex_login_open_window', { url, proxyUrl, code });
}

export async function codexLoginCloseWindow(): Promise<void> {
    await invoke('codex_login_window_close');
}
