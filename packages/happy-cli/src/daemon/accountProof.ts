/**
 * Proving a request comes from the account, on a channel the server is not part of.
 *
 * The account is the administrator of the machine, and it already proves that to the server by
 * signing a challenge (`authChallenge` → `POST /v1/auth`). The machine can check the very same
 * thing, because it already holds the account's public key — it derives the mDNS account
 * fingerprint from it. So a side-effecting request on the machine's own channel can be authorised
 * by the account rather than by the machine key, with no new key material and no server in the
 * loop.
 *
 * That distinction is the whole point: the machine key is a *transport* credential that every
 * paired device holds, so "can connect" and "may start a process" would otherwise be the same
 * thing. And it is not a per-channel rule — a key holder can derive the relay tag and arrive the
 * other way — so this check lives on the route and both channels pass through it.
 *
 * The signed message covers the method, the target, a nonce and a timestamp, so a signature is
 * good for exactly one request: a lifted one cannot be pointed at another action, and a fresh
 * nonce cannot be answered with an old signature.
 *
 * Pure, with the signature check injected, so the awkward parts — freshness, one-shot nonces and
 * the canonical bytes both sides must agree on — are testable without libsodium.
 */

/** What a caller attaches to prove it holds the account key. */
export type AccountProof = {
    /** Random per request; a signature that arrives twice is refused the second time. */
    nonce: string;
    /** When it was signed. Bounded, so a leaked signature is not good forever. */
    at: number;
    /** base64 detached Ed25519 signature over `accountProofMessage(...)`. */
    signature: string;
};

/**
 * How long a signature is good for.
 *
 * Long enough for a slow request on a slow channel, short enough that a signature lifted off the
 * wire stops being useful quickly. This is the window a passive listener on a plain-HTTP LAN has,
 * which is exactly why the nonce matters as much as the window does.
 */
export const ACCOUNT_PROOF_WINDOW_MS = 60_000;

/**
 * The bytes a signature covers.
 *
 * Canonical and positional rather than a JSON blob: both sides have to build the identical string,
 * and JSON key order is not something two implementations agree on by accident. The body is
 * included by digest so a signature cannot be moved to a different payload.
 */
/**
 * The bytes the proof covers, as of v2 — and what changed, and why.
 *
 * v1 covered the request's **path**, which was a mistake: a path is not an identity. It changes as a
 * request travels (through the relay it grows an `/r/<tag>` prefix, and a reverse proxy may rewrite
 * it again), so two parties looking at the same request disagreed about the string and the signature
 * failed — which is exactly what happened to every signed request that arrived through the relay,
 * while direct LAN requests kept working because both sides saw the same path.
 *
 * v2 covers what the proof is actually about: the **action** and its **target**. Both are properties
 * of the request rather than of the route it took, so the same call signs the same bytes however it
 * reaches the machine.
 */
export function accountProofMessage(parts: {
    /** What is being asked for: `restart`, `control`. */
    operation: string;
    /** What it is being asked of: the session id, or `-` for the machine itself. */
    target: string;
    nonce: string;
    at: number;
    /** A digest of the request body — see `digestOf`. */
    bodyDigest: string;
}): string {
    return ['happy-lan-account-proof-v2', parts.operation, parts.target, parts.nonce, String(parts.at), parts.bodyDigest].join('\n');
}

/**
 * The v1 message, kept so a proof signed by an App that has not updated still verifies.
 *
 * Only ever checkable on a direct connection: the path is what the caller saw, and a caller arriving
 * through the relay saw a different one. That is the bug v2 fixes, and it is why this is a
 * compatibility path rather than a supported one.
 */
export function accountProofMessageV1(parts: {
    method: string;
    path: string;
    nonce: string;
    at: number;
    bodyDigest: string;
}): string {
    return ['happy-lan-account-proof-v1', parts.method.toUpperCase(), parts.path, parts.nonce, String(parts.at), parts.bodyDigest].join('\n');
}

/** Whether a proof authorises this request, now. */
export function verifyAccountProof(args: {
    proof: AccountProof | null | undefined;
    /** The v2 message: what the proof is about. */
    message: string;
    /**
     * The v1 message to fall back to, for a proof signed by an App that has not updated. Left out
     * where a route has no meaningful path (and where v1 could not have been used anyway).
     */
    legacyMessage?: string;
    /** Whether this nonce has already been used. One-shot, so a replay is refused. */
    nonceSeen: (nonce: string) => boolean;
    /** Checks the signature over the message with the account's public key. */
    verify: (message: string, signature: string) => boolean;
    now?: number;
    windowMs?: number;
}): { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'replayed' | 'bad-signature' } {
    const { proof } = args;
    if (!proof || typeof proof.nonce !== 'string' || proof.nonce.length === 0
        || typeof proof.at !== 'number' || typeof proof.signature !== 'string') {
        return { ok: false, reason: 'missing' };
    }
    const now = args.now ?? Date.now();
    const window = args.windowMs ?? ACCOUNT_PROOF_WINDOW_MS;
    // Both directions: a clock ahead of ours is as suspect as one behind, and a signature from the
    // future is the shape a clock-skew attack takes.
    if (Math.abs(now - proof.at) > window) {
        return { ok: false, reason: 'stale' };
    }
    if (args.nonceSeen(proof.nonce)) {
        return { ok: false, reason: 'replayed' };
    }
    // v2 first, then v1: an App that has updated signs the action and its target, one that has not
    // signs the path it saw. The nonce is spent only by a proof that verified, so a failed v2 does
    // not stop the v1 that follows.
    const verified = args.verify(args.message, proof.signature)
        || (args.legacyMessage !== undefined && args.verify(args.legacyMessage, proof.signature));
    if (!verified) {
        return { ok: false, reason: 'bad-signature' };
    }
    return { ok: true };
}
