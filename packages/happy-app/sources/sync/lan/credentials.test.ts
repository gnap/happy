import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same reason as the other LAN tests: the proof is an HMAC over the machine key, and that is a
// native module on device. The daemon's answer is what is under test here, not the MAC.
vi.mock('@/encryption/hmac_sha256', () => ({ hmac_sha256: vi.fn(async () => new Uint8Array(32)) }));

const { getLanCredential, invalidateLanCredential, resetLanCredentials } = await import('./credentials');

const base = 'http://10.0.0.2:55673';
const key = new Uint8Array(32);

/** What the daemon hands out, in the order the tests need to be able to recognise them. */
let tokens = 0;
let ttl = 90_000;
let calls: string[] = [];

/** A daemon that answers the challenge-response pair, counting what it was asked for. */
function stubDaemon() {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url).replace(base, '')}`);
        if (String(url).endsWith('/lan/challenge')) {
            return { ok: true, status: 200, json: async () => ({ nonce: `nonce-${tokens + 1}` }) } as unknown as Response;
        }
        tokens += 1;
        return { ok: true, status: 200, json: async () => ({ token: `t${tokens}`, expiresAt: Date.now() + ttl }) } as unknown as Response;
    }));
}

beforeEach(() => {
    tokens = 0;
    ttl = 90_000;
    resetLanCredentials();
    stubDaemon();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('getLanCredential', () => {
    it('hands every caller the same token instead of one per caller', async () => {
        // The point of the module: four sessions being polled are four readers of one daemon, not
        // four clients, and each used to run its own handshake every time its token aged out.
        const first = await getLanCredential(base, key);
        const second = await getLanCredential(base, key);
        expect(second.token).toBe(first.token);
        expect(calls).toEqual(['POST /lan/challenge', 'POST /lan/session']);
    });

    it('runs one handshake for callers that arrive while one is in flight', async () => {
        const [a, b] = await Promise.all([getLanCredential(base, key), getLanCredential(base, key)]);
        expect(a.token).toBe(b.token);
        expect(calls).toEqual(['POST /lan/challenge', 'POST /lan/session']);
    });

    it('replaces a token before it expires, so no read is answered with a 401 for age', async () => {
        // A token with less than the refresh margin left is still *returned* — it is valid — but a
        // fresh one is fetched alongside it, so the next call finds a replacement in place. That is
        // what keeps the expiry off the read path: nothing ever waits for a handshake it could have
        // done earlier, and a read never starts on a token that dies mid-flight.
        ttl = 20_000;
        const first = await getLanCredential(base, key);
        await getLanCredential(base, key);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const afterRefresh = await getLanCredential(base, key);
        expect(afterRefresh.token).not.toBe(first.token);
        expect(calls.filter((call) => call.endsWith('/lan/session'))).toHaveLength(2);
    });

    it('waits for a handshake once the token has actually expired', async () => {
        ttl = -1;
        const expired = await getLanCredential(base, key);
        const fresh = await getLanCredential(base, key);
        expect(fresh.token).not.toBe(expired.token);
    });

    it('replaces a token the daemon rejected', async () => {
        const first = await getLanCredential(base, key);
        invalidateLanCredential(base);
        const second = await getLanCredential(base, key);
        expect(second.token).not.toBe(first.token);
    });

    it('does not hand a failed handshake to the next caller', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
        await expect(getLanCredential(base, key)).rejects.toThrow();
        stubDaemon();
        await expect(getLanCredential(base, key)).resolves.toMatchObject({ token: 't1' });
    });
});
