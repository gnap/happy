/**
 * Proving a request comes from the account, on a channel the server is not part of.
 *
 * The account is the administrator of the machine, and it already proves that to the server by
 * signing a challenge. The machine checks the same thing with the public key it already holds, so a
 * side-effecting request over the machine's own channel is authorised by the *account* rather than
 * by the machine key every paired device holds.
 *
 * The message is positional and canonical so both sides build identical bytes; a JSON blob would
 * depend on key order, which two implementations do not agree on by accident. It is duplicated here
 * and in the CLI's `daemon/accountProof.ts` for now, with a test on each side pinning the same
 * literal — the pair belongs in `happy-wire`, where both can import one copy.
 */

import sodium from '@/encryption/libsodium.lib';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { TokenStorage } from './tokenStorage';
import { log } from '@/log';

export const ACCOUNT_PROOF_WINDOW_MS = 60_000;

export type AccountProofHeaders = Record<string, string>;

/**
 * The bytes a signature covers. Must match `accountProofMessage` in the CLI.
 *
 * The action and its target, not the path the request travels: a path changes with the route (through
 * the relay it grows an `/r/<tag>` prefix), so signing one meant the machine and the App disagreed
 * about the bytes and every proof that arrived through the relay was refused. A request's identity
 * does not depend on how it got there.
 */
export function accountProofMessage(parts: {
    /** What is being asked for: `restart`, `control`. */
    operation: string;
    /** What it is being asked of: the session id. */
    target: string;
    nonce: string;
    at: number;
    bodyDigest: string;
}): string {
    return ['happy-lan-account-proof-v2', parts.operation, parts.target, parts.nonce, String(parts.at), parts.bodyDigest].join('\n');
}

/** A random one-shot nonce, so a signature cannot be used twice. */
function freshNonce(): string {
    const bytes = sodium.randombytes_buf(16);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The headers that authorise one request, or null when this device cannot sign.
 *
 * Null rather than a throw: a device that is not signed in has no account to speak for, and the
 * caller falls back to the server — which is where these actions went before any of this existed.
 */
export async function accountProofHeaders(parts: { operation: string; target: string }): Promise<AccountProofHeaders | null> {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials?.secret) {
        return null;
    }
    try {
        // The stored secret is base64url (`AuthContext.login` encodes it that way); decoding it as
        // standard base64 yields different bytes, hence a valid signature from the wrong keypair.
        const keypair = sodium.crypto_sign_seed_keypair(decodeBase64(credentials.secret, 'base64url'));
        const at = Date.now();
        const nonce = freshNonce();
        const message = accountProofMessage({ operation: parts.operation, target: parts.target, nonce, at, bodyDigest: '' });
        const signature = sodium.crypto_sign_detached(new TextEncoder().encode(message), keypair.privateKey);
        // Which key signed it, so a `bad-signature` a machine refuses can be answered with a
        // comparison rather than a guess: the daemon verifies against the *account* public key, and
        // a proof made with any other key is a valid signature of the same bytes. Printed here
        // because this is the only place the App knows both the key and the bytes it covered.
        log.log(`🔑 account proof: signed ${parts.operation}:${parts.target} with ${encodeBase64(keypair.publicKey)}`);
        return {
            'x-happy-proof-nonce': nonce,
            'x-happy-proof-at': String(at),
            'x-happy-proof-signature': encodeBase64(signature),
        };
    } catch {
        return null;
    }
}
