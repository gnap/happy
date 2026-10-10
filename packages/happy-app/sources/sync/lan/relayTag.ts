/**
 * The relay tag a machine is reachable under, derived locally from its machine key.
 *
 * The daemon publishes this route through the server, which is fine until the server is the thing
 * that is down — and then the App has no way to learn an address it could have computed: the tag is
 * a pure function of the machine key, and the App has held that key since pairing. Deriving it here
 * is what lets the relay be reached with the server switched off, which is the only reason the
 * relay exists at all.
 *
 * The derivation must match `deriveRelayIdentity` in the CLI and `tagOfPublicKey` in the relay byte
 * for byte: HKDF-SHA256 with an empty salt and the info below, an ed25519 key pair from that seed,
 * and the first 32 hex characters of SHA-256 over its public key.
 */
export type RelayCrypto = {
    hmacSha256: (key: Uint8Array, data: Uint8Array) => Promise<Uint8Array>;
    sha256: (data: Uint8Array) => Promise<Uint8Array>;
    /** ed25519, from a 32-byte seed. */
    signKeyPairFromSeed: (seed: Uint8Array) => { publicKey: Uint8Array };
};

const INFO = new TextEncoder().encode('happy-relay-v1');
const HASH_LEN = 32;

/** RFC 5869 with SHA-256: extract, then expand. */
async function hkdfSha256(ikm: Uint8Array, info: Uint8Array, length: number, crypto: RelayCrypto): Promise<Uint8Array> {
    const prk = await crypto.hmacSha256(new Uint8Array(HASH_LEN), ikm);
    const out = new Uint8Array(length);
    let block: Uint8Array = new Uint8Array(0);
    let written = 0;
    for (let counter = 1; written < length; counter += 1) {
        const input = new Uint8Array(block.length + info.length + 1);
        input.set(block, 0);
        input.set(info, block.length);
        input[input.length - 1] = counter;
        block = await crypto.hmacSha256(prk, input);
        const take = Math.min(block.length, length - written);
        out.set(block.subarray(0, take), written);
        written += take;
    }
    return out;
}

const toHex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function relayTagFor(machineKey: Uint8Array, crypto: RelayCrypto): Promise<string> {
    const seed = await hkdfSha256(machineKey, INFO, HASH_LEN, crypto);
    const pair = crypto.signKeyPairFromSeed(seed);
    return toHex(await crypto.sha256(pair.publicKey)).slice(0, 32);
}

/** `https://relay.example` + tag → the route under which the relay serves a machine's LAN API. */
export function relayBaseUrlFor(relayUrl: string, tag: string): string {
    return `${relayUrl.replace(/\/+$/, '')}/r/${tag}`;
}
