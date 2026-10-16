import { describe, expect, it } from 'vitest';
import { accountProofMessage } from './accountProof';

describe('accountProofMessage', () => {
    it('builds exactly the bytes the daemon builds', () => {
        // Pinned to a literal on both sides on purpose: the two implementations must agree byte for
        // byte, and a test that computed the expected value the same way would not notice a drift.
        expect(accountProofMessage({
            method: 'POST',
            path: '/lan/sessions/sess-1/control',
            nonce: 'n-1',
            at: 1_800_000_000_000,
            bodyDigest: 'abc',
        })).toBe('happy-lan-account-proof-v1\nPOST\n/lan/sessions/sess-1/control\nn-1\n1800000000000\nabc');
    });

    it('does not depend on how the caller capitalised the method', () => {
        const parts = { path: '/x', nonce: 'n', at: 1, bodyDigest: '' };
        expect(accountProofMessage({ ...parts, method: 'post' })).toBe(accountProofMessage({ ...parts, method: 'POST' }));
    });
});
