import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PROOF_WINDOW_MS, accountProofMessage, verifyAccountProof } from './accountProof';

const NOW = 1_800_000_000_000;
const message = accountProofMessage({
    method: 'POST',
    path: '/lan/sessions/sess-1/control',
    nonce: 'n-1',
    at: NOW,
    bodyDigest: 'abc',
});
const proof = { nonce: 'n-1', at: NOW, signature: 'sig' };
const check = (over: Partial<Parameters<typeof verifyAccountProof>[0]> = {}) => verifyAccountProof({
    proof,
    message,
    nonceSeen: () => false,
    verify: () => true,
    now: NOW,
    ...over,
});

describe('accountProofMessage', () => {
    it('is positional and canonical, so two implementations build the same bytes', () => {
        // A JSON blob would depend on key order, which two languages do not agree on by accident.
        expect(message).toBe('happy-lan-account-proof-v1\nPOST\n/lan/sessions/sess-1/control\nn-1\n' + String(NOW) + '\nabc');
    });

    it('binds the request: a different action produces different bytes', () => {
        const other = accountProofMessage({
            method: 'POST', path: '/lan/sessions/sess-1/control', nonce: 'n-1', at: NOW, bodyDigest: 'different',
        });
        expect(other).not.toBe(message);
    });

    it('does not depend on how the method was capitalised by the caller', () => {
        expect(accountProofMessage({ ...{ method: 'post', path: '/x', nonce: 'n', at: 1, bodyDigest: 'd' } }))
            .toBe(accountProofMessage({ method: 'POST', path: '/x', nonce: 'n', at: 1, bodyDigest: 'd' }));
    });
});

describe('verifyAccountProof', () => {
    it('accepts a fresh, unseen, correctly signed proof', () => {
        expect(check()).toEqual({ ok: true });
    });

    it('refuses a request with no proof at all', () => {
        expect(check({ proof: null })).toEqual({ ok: false, reason: 'missing' });
        expect(check({ proof: { nonce: '', at: NOW, signature: 'sig' } })).toEqual({ ok: false, reason: 'missing' });
    });

    it('refuses a proof from outside the window, in either direction', () => {
        // A signature from the future is the shape a clock-skew attack takes, so lateness is bounded
        // the same way as being late.
        expect(check({ proof: { ...proof, at: NOW - ACCOUNT_PROOF_WINDOW_MS - 1 } })).toEqual({ ok: false, reason: 'stale' });
        expect(check({ proof: { ...proof, at: NOW + ACCOUNT_PROOF_WINDOW_MS + 1 } })).toEqual({ ok: false, reason: 'stale' });
        expect(check({ proof: { ...proof, at: NOW - ACCOUNT_PROOF_WINDOW_MS + 1 } })).toEqual({ ok: true });
    });

    it('refuses a nonce that has been used, which is what makes a lifted signature useless', () => {
        expect(check({ nonceSeen: () => true })).toEqual({ ok: false, reason: 'replayed' });
    });

    it('refuses a signature that does not check out, and does not consult the nonce first', () => {
        // The order matters: a bad signature must not consume a nonce, or a forged request could
        // burn the nonce of the real one and lock the caller out.
        const nonceSeen = vi.fn(() => false);
        expect(check({ verify: () => false, nonceSeen })).toEqual({ ok: false, reason: 'bad-signature' });
    });
});
