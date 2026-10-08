/**
 * Client for the CLI daemon's read-only LAN API.
 *
 * Authentication is a challenge-response over the *machine key* — the 32-byte symmetric secret
 * the CLI generated at auth time and wrapped into the machine record. The App already unwraps
 * that record to decrypt `daemonState`, so the key is on hand and no new key distribution is
 * needed. The key never travels: the client proves possession and receives a short-lived
 * bearer token (90s, enforced server-side) instead.
 *
 * The transport is deliberately plain HTTP, which is why the App declares
 * `NSAllowsLocalNetworking` in app.config.js. A token is therefore sniffable on the LAN; the
 * short TTL is the mitigation, and the API is read-only.
 *
 * All functions take the base URL explicitly rather than reading any global, so the whole
 * module can be exercised against an ephemeral port.
 */

import { hmac_sha256 } from '@/encryption/hmac_sha256';
import { encodeUTF8 } from '@/encryption/text';
import { encodeBase64 } from '@/encryption/base64';
import type { LanHistory, LanIdentity, LanSessionSummary } from './types';

/** A challenge is worthless once the daemon's nonce expires; don't hang on a wedged host. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The proof context string — must match `PROOF_CONTEXT` in the CLI's lanServer.ts. */
const PROOF_CONTEXT = 'v1.proof';

export class LanRequestError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = 'LanRequestError';
    }
}

/**
 * The proof a LAN client returns for a challenge nonce. Must equal `lanProofFor` in
 * `packages/happy-cli/src/daemon/lanServer.ts` byte for byte.
 */
export async function lanProofFor(machineKey: Uint8Array, nonce: string): Promise<string> {
    const mac = await hmac_sha256(machineKey, encodeUTF8(`${PROOF_CONTEXT}.${nonce}`));
    return encodeBase64(mac, 'base64url');
}

async function request(
    url: string,
    init: RequestInit & { token?: string } = {}
): Promise<Response> {
    const { token, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...rest,
            signal: controller.signal,
            headers: {
                ...(rest.headers ?? {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Exchanges the machine key for a bearer token via the challenge-response pair.
 * Throws when the daemon is unreachable or rejects the proof.
 */
export async function authenticate(
    baseUrl: string,
    machineKey: Uint8Array
): Promise<{ token: string; expiresAt: number }> {
    const challengeResponse = await request(`${baseUrl}/lan/challenge`, { method: 'POST' });
    if (!challengeResponse.ok) {
        throw new LanRequestError('challenge rejected', challengeResponse.status);
    }
    const { nonce } = (await challengeResponse.json()) as { nonce: string };

    const proof = await lanProofFor(machineKey, nonce);
    const sessionResponse = await request(`${baseUrl}/lan/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, proof }),
    });
    if (!sessionResponse.ok) {
        throw new LanRequestError('proof rejected', sessionResponse.status);
    }
    return (await sessionResponse.json()) as { token: string; expiresAt: number };
}

export async function fetchIdentity(baseUrl: string, token: string): Promise<LanIdentity> {
    const response = await request(`${baseUrl}/lan/identity`, { token });
    if (!response.ok) {
        throw new LanRequestError('identity request failed', response.status);
    }
    return (await response.json()) as LanIdentity;
}

export async function fetchSessions(baseUrl: string, token: string): Promise<LanSessionSummary[]> {
    const response = await request(`${baseUrl}/lan/sessions`, { token });
    if (!response.ok) {
        throw new LanRequestError('sessions request failed', response.status);
    }
    const body = (await response.json()) as { sessions: LanSessionSummary[] };
    return body.sessions;
}

/**
 * Fetches a session's local history.
 *
 * `since` is the cursor from the previous read; the daemon then returns only what was appended
 * after it. That matters more than it looks: without a cursor every poll re-sends and re-decrypts
 * the whole log, so the cost of a tick grows with the session's length and the channel gets
 * slower the longer it runs.
 *
 * Returns null for 404, which the daemon uses for "this machine has no local history for that
 * session yet" — a retryable condition, deliberately distinct from the 401 an unauthorised
 * caller gets. Other failures throw.
 */
export async function fetchHistory(
    baseUrl: string,
    token: string,
    sessionId: string,
    since?: string
): Promise<LanHistory | null> {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    const response = await request(
        `${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/history${query}`,
        { token }
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new LanRequestError('history request failed', response.status);
    }
    return (await response.json()) as LanHistory;
}
