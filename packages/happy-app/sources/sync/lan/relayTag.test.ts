import { createHash, createHmac, createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { relayBaseUrlFor, relayTagFor, type RelayCrypto } from './relayTag';

// The machine key and the tag it must produce, taken from the CLI's `deriveRelayIdentity`. The two
// implementations are a protocol shared by the App, the daemon and the relay, so this vector is
// what keeps them from drifting apart.
const MACHINE_KEY = new Uint8Array(32).fill(7);
const EXPECTED_TAG = 'd51860ec6280763259127ac82b6f7b82';

/** ed25519 in Node wants PKCS#8, and a 32-byte seed is a PKCS#8 key with a fixed prefix. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const crypto: RelayCrypto = {
    hmacSha256: async (key, data) => new Uint8Array(createHmac('sha256', key).update(data).digest()),
    sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest()),
    signKeyPairFromSeed: (seed) => {
        const privateKey = createPrivateKey({
            key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
            format: 'der',
            type: 'pkcs8',
        });
        const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
        return { publicKey: new Uint8Array(raw.subarray(raw.length - 32)) };
    },
};

describe('relayTagFor', () => {
    it('derives the same tag the CLI and the relay derive', async () => {
        expect(await relayTagFor(MACHINE_KEY, crypto)).toBe(EXPECTED_TAG);
    });

    it('gives a different tag for a different key', async () => {
        expect(await relayTagFor(new Uint8Array(32).fill(8), crypto)).not.toBe(EXPECTED_TAG);
    });
});

describe('relayBaseUrlFor', () => {
    it('builds the route the relay serves, with or without a trailing slash', () => {
        expect(relayBaseUrlFor('https://relay.example', EXPECTED_TAG)).toBe(`https://relay.example/r/${EXPECTED_TAG}`);
        expect(relayBaseUrlFor('https://relay.example/', EXPECTED_TAG)).toBe(`https://relay.example/r/${EXPECTED_TAG}`);
    });
});
