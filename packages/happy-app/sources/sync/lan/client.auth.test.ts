import { afterEach, describe, expect, it, vi } from 'vitest';

// The real client is what is under test, and its proof is HMAC over the machine key — a native
// module on device, so it is stubbed for the same reason the other LAN tests stub the client.
vi.mock('@/encryption/hmac_sha256', () => ({ hmac_sha256: vi.fn(async () => new Uint8Array(32)) }));

const { authenticate } = await import('./client');

const base = 'http://10.0.0.2:55673';
const key = new Uint8Array(32);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** A daemon that answers a challenge and then a token, counting what it was asked for. */
function stubDaemon() {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url).replace(base, '')}`);
        if (String(url).endsWith('/lan/challenge')) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { ok: true, status: 200, json: async () => ({ nonce: 'n1' }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ token: 't1', expiresAt: Date.now() + 90_000 }) } as unknown as Response;
    }));
    return calls;
}

describe('authenticate', () => {
    it('runs one handshake for callers that ask at the same time', async () => {
        // A read, the socket that read opens and the retry after either fails all ask at once; each
        // used to run its own challenge against a daemon that rate-limits exactly that.
        const calls = stubDaemon();
        const [a, b] = await Promise.all([authenticate(base, key), authenticate(base, key)]);
        expect(a.token).toBe('t1');
        expect(b.token).toBe('t1');
        expect(calls).toEqual(['POST /lan/challenge', 'POST /lan/session']);
    });

    it('asks again for a later caller, rather than handing over a finished handshake', async () => {
        const calls = stubDaemon();
        await authenticate(base, key);
        await authenticate(base, key);
        expect(calls.filter((call) => call.endsWith('/lan/challenge'))).toHaveLength(2);
    });
});
