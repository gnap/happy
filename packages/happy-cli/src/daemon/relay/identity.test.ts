import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { deriveRelayIdentity, signRegistration, REGISTER_CONTEXT } from './identity';

describe('relay identity', () => {
  const key = new Uint8Array(32).map((_, i) => i + 1);

  it('is deterministic per machine key and differs across keys', () => {
    const a = deriveRelayIdentity(key);
    expect(deriveRelayIdentity(key).tag).toBe(a.tag);
    expect(deriveRelayIdentity(new Uint8Array(32).fill(9)).tag).not.toBe(a.tag);
  });

  it('tag is the first 32 hex chars of sha256(publicKey), as the relay computes it', () => {
    const id = deriveRelayIdentity(key);
    expect(id.tag).toBe(createHash('sha256').update(id.publicKey).digest('hex').slice(0, 32));
  });

  it('signs the relay challenge so the relay can verify it with the public key alone', () => {
    const id = deriveRelayIdentity(key);
    const sig = Buffer.from(signRegistration(id, 'nonce-1'), 'base64');
    expect(nacl.sign.detached.verify(Buffer.from(REGISTER_CONTEXT + 'nonce-1'), sig, id.publicKey)).toBe(true);
    expect(nacl.sign.detached.verify(Buffer.from(REGISTER_CONTEXT + 'nonce-2'), sig, id.publicKey)).toBe(false);
  });
});
