import * as Crypto from 'expo-crypto';

/**
 * HMAC-SHA256 built on expo-crypto's digest.
 *
 * Implemented by hand for the same reason as `hmac_sha512.ts`: the native libsodium binding
 * does not expose `crypto_auth_hmacsha256`, only the plain-JS wrapper package does.
 *
 * The LAN challenge-response (`/lan/session`) verifies the proof as
 * `HMAC-SHA256(machineKey, "v1.proof." + nonce)` — the machine key is always 32 bytes, so the
 * key-longer-than-block branch never fires on that path, but it is kept for correctness.
 */
export async function hmac_sha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const blockSize = 64; // SHA256 block size in bytes
    const opad = 0x5c;
    const ipad = 0x36;

    // Prepare key
    let actualKey = key;
    if (key.length > blockSize) {
        // If key is longer than block size, hash it
        const keyHash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(key));
        actualKey = new Uint8Array(keyHash);
    }

    // Pad key to block size
    const paddedKey = new Uint8Array(blockSize);
    paddedKey.set(actualKey);

    // Create inner and outer padded keys
    const innerKey = new Uint8Array(blockSize);
    const outerKey = new Uint8Array(blockSize);

    for (let i = 0; i < blockSize; i++) {
        innerKey[i] = paddedKey[i] ^ ipad;
        outerKey[i] = paddedKey[i] ^ opad;
    }

    // Inner hash: SHA256(innerKey || data)
    const innerData = new Uint8Array(blockSize + data.length);
    innerData.set(innerKey);
    innerData.set(data, blockSize);
    const innerHash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, innerData);

    // Outer hash: SHA256(outerKey || innerHash)
    const outerData = new Uint8Array(blockSize + 32); // 32 bytes for SHA256 hash
    outerData.set(outerKey);
    outerData.set(new Uint8Array(innerHash), blockSize);
    const finalHash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, outerData);

    return new Uint8Array(finalHash);
}
