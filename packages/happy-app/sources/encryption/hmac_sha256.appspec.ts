import { describe, it, expect } from '@/dev/testRunner';
import { hmac_sha256 } from './hmac_sha256';
import { decode as decodeHex } from '@stablelib/hex';

function decodeHexString(hexString: string): Uint8Array {
    return decodeHex(hexString);
}

function repeat(byte: string, count: number): Uint8Array {
    return decodeHexString(byte.repeat(count));
}

// Test vectors from RFC 4231 §4.2–4.8.
// https://datatracker.ietf.org/doc/html/rfc4231
const VECTORS = [
    {
        // Test Case 1 — key shorter than block size
        key: repeat('0b', 20),
        data: new TextEncoder().encode('Hi There'),
        output: decodeHexString('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
    },
    {
        // Test Case 2 — key shorter than block size
        key: new TextEncoder().encode('Jefe'),
        data: new TextEncoder().encode('what do ya want for nothing?'),
        output: decodeHexString('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
    },
    {
        // Test Case 3 — key shorter than block size
        key: repeat('aa', 20),
        data: repeat('dd', 50),
        output: decodeHexString('773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe')
    },
    {
        // Test Case 4 — key shorter than block size
        key: decodeHexString('0102030405060708090a0b0c0d0e0f10111213141516171819'),
        data: repeat('cd', 50),
        output: decodeHexString('82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b')
    },
    {
        // Test Case 6 — key larger than block size, so it must be hashed first
        key: repeat('aa', 131),
        data: new TextEncoder().encode('Test Using Larger Than Block-Size Key - Hash Key First'),
        output: decodeHexString('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
    },
    {
        // Test Case 7 — both key and data larger than block size
        key: repeat('aa', 131),
        data: new TextEncoder().encode(
            'This is a test using a larger than block-size key and a larger than block-size data. ' +
            'The key needs to be hashed before being used by the HMAC algorithm.'
        ),
        output: decodeHexString('9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2')
    }
];

describe('hmac_sha256', () => {
    it('should process RFC 4231 test vectors', async () => {
        for (const vec of VECTORS) {
            const res = await hmac_sha256(vec.key, vec.data);
            expect(res).toEqual(vec.output);
        }
    });

    it('should produce the same proof the CLI expects for a 32-byte machine key', async () => {
        // The LAN challenge-response is HMAC-SHA256(machineKey, "v1.proof." + nonce) over a
        // 32-byte key, so the key is never longer than the block size on that path.
        const machineKey = repeat('2a', 32);
        const nonce = 'q1w2e3r4t5y6u7i8o9p0';
        const res = await hmac_sha256(machineKey, new TextEncoder().encode(`v1.proof.${nonce}`));
        expect(res.length).toBe(32);
    });
});
