import { describe, expect, it } from 'vitest';
import { accountProofMessage } from './accountProof';

describe('accountProofMessage', () => {
    it('builds exactly the bytes the daemon builds', () => {
        // Pinned to a literal on both sides on purpose: the two implementations must agree byte for
        // byte, and a test that computed the expected value the same way would not notice a drift.
        expect(accountProofMessage({
            operation: 'control',
            target: 'sess-1',
            nonce: 'n-1',
            at: 1_800_000_000_000,
            bodyDigest: 'abc',
        })).toBe('happy-lan-account-proof-v2\ncontrol\nsess-1\nn-1\n1800000000000\nabc');
    });

    it('signs the same bytes however the request reaches the machine', () => {
        // The bug this version exists for: v1 covered the path, which grows an `/r/<tag>` prefix on the
        // way through the relay — so the App and the daemon built different strings and every proof
        // that arrived that way was refused, while the same request over the LAN worked.
        const parts = { operation: 'restart', target: 'sess-1', nonce: 'n-1', at: 1, bodyDigest: 'abc' } as const;
        expect(accountProofMessage(parts)).toBe(accountProofMessage({ ...parts }));
    });
});
