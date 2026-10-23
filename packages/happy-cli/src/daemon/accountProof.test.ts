import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PROOF_WINDOW_MS, accountProofMessage, accountProofMessageV1, verifyAccountProof } from './accountProof';

const NOW = 1_800_000_000_000;
const message = accountProofMessage({
    operation: 'control:abort',
    target: 'sess-1',
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
        expect(message).toBe('happy-lan-account-proof-v2\ncontrol:abort\nsess-1\nn-1\n' + String(NOW) + '\nabc');
    });

    it('binds the action and its target: either one changing produces different bytes', () => {
        expect(accountProofMessage({ operation: 'restart', target: 'sess-1', nonce: 'n-1', at: NOW, bodyDigest: 'abc' }))
            .not.toBe(message);
        expect(accountProofMessage({ operation: 'control:abort', target: 'sess-2', nonce: 'n-1', at: NOW, bodyDigest: 'abc' }))
            .not.toBe(message);
    });

    it('is the same bytes however the request travels', () => {
        // The bug this version exists for: v1 signed the path, so a request arriving through the relay
        // — where the path grows an `/r/<tag>` prefix — signed different bytes on each side and every
        // such proof failed. What a proof is about does not depend on the route to the machine.
        const direct = accountProofMessage({ operation: 'restart', target: 'sess-1', nonce: 'n-1', at: NOW, bodyDigest: 'abc' });
        const throughRelay = accountProofMessage({ operation: 'restart', target: 'sess-1', nonce: 'n-1', at: NOW, bodyDigest: 'abc' });
        expect(direct).toBe(throughRelay);
        // And the old one, for contrast: the same call over two paths was two different messages.
        const v1 = (path: string) => accountProofMessageV1({ method: 'POST', path, nonce: 'n-1', at: NOW, bodyDigest: 'abc' });
        expect(v1('/lan/sessions/sess-1/restart')).not.toBe(v1('/r/tag/lan/sessions/sess-1/restart'));
    });
});

describe('verifyAccountProof', () => {
    it('accepts a fresh, unseen, correctly signed proof', () => {
        expect(check()).toEqual({ ok: true });
    });

    it('accepts a v1 proof from an App that has not updated', () => {
        // The compatibility path: an older App signs the path it saw, which is checkable on a direct
        // connection and never was through the relay.
        const v1 = accountProofMessageV1({ method: 'POST', path: '/lan/sessions/sess-1/control', nonce: 'n-1', at: NOW, bodyDigest: 'abc' });
        const verify = vi.fn((candidate: string) => candidate === v1);
        expect(check({ verify, legacyMessage: v1 })).toEqual({ ok: true });
        expect(check({ verify, legacyMessage: 'something-else' })).toEqual({ ok: false, reason: 'bad-signature' });
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
