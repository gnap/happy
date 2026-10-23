import nacl from 'tweetnacl';
import { createHash, hkdfSync } from 'node:crypto';

/** Must match `REGISTER_CONTEXT` in packages/happy-relay/src/relay.ts. */
export const REGISTER_CONTEXT = 'happy-relay-v1.register.';

export type RelayIdentity = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** What clients address this daemon by: the first 32 hex chars of SHA-256(publicKey). */
  tag: string;
};

/**
 * The relay identity is derived from the machine key, so it needs no new key distribution:
 * anything that holds the machine key can compute the same tag, and nothing else can sign for it.
 */
export function deriveRelayIdentity(machineKey: Uint8Array): RelayIdentity {
  const seed = new Uint8Array(hkdfSync('sha256', machineKey, new Uint8Array(0), 'happy-relay-v1', 32));
  const pair = nacl.sign.keyPair.fromSeed(seed);
  const tag = createHash('sha256').update(pair.publicKey).digest('hex').slice(0, 32);
  return { publicKey: pair.publicKey, secretKey: pair.secretKey, tag };
}

export function signRegistration(identity: RelayIdentity, nonce: string): string {
  const sig = nacl.sign.detached(new TextEncoder().encode(REGISTER_CONTEXT + nonce), identity.secretKey);
  return Buffer.from(sig).toString('base64');
}
