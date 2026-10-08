/**
 * The LAN API is exposed to a hostile-ish shared network, so these tests focus on the parts
 * that are easy to get subtly wrong: nonce single-use, the bounded nonce store, and the fact
 * that no mutation route exists. They run against a real server on an ephemeral port with no
 * daemon and no `configuration`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLanServer, lanProofFor, LAN_PROTOCOL_VERSION, type LanHistory, type LanServerHandle, type LanSessionSummary } from './lanServer';

const SECRET = new Uint8Array(32).fill(3);
const WRONG_SECRET = new Uint8Array(32).fill(4);

const SESSIONS: LanSessionSummary[] = [
    { happySessionId: 'sess-1', directory: '/work/repo', agent: 'claude', startedBy: 'daemon', isAlive: true },
];

const HISTORY: LanHistory = {
    tag: 'tag-1',
    dataEncryptionKey: 'WRAPPED-KEY',
    entries: [{ id: 'id-1', localId: 'local-1', dir: 'out', at: 1, c: 'CIPHER-1' }],
    cursor: '0:1',
    reset: false,
};
/** Mutable so a test can simulate a session whose history this machine does not have. */
let history: LanHistory | null = HISTORY;
/** What the route passed down, so the cursor plumbing can be asserted rather than assumed. */
let lastSince: string | undefined;

let server: LanServerHandle | null = null;

async function start(limits?: Parameters<typeof startLanServer>[0]['limits']) {
    server = await startLanServer({
        secret: SECRET,
        machineId: 'machine-1',
        accountFingerprint: 'acct-fingerprint',
        getSessions: () => SESSIONS,
        getHistory: (_sessionId, since) => {
            lastSince = since;
            return history;
        },
        host: '127.0.0.1',
        port: 0,
        limits,
    });
    return server;
}

const url = (path: string) => `http://127.0.0.1:${server!.port}${path}`;

async function getChallenge(): Promise<string> {
    const res = await fetch(url('/lan/challenge'), { method: 'POST' });
    expect(res.status).toBe(200);
    return ((await res.json()) as { nonce: string }).nonce;
}

async function redeem(nonce: string, secret: Uint8Array = SECRET) {
    return fetch(url('/lan/session'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, proof: lanProofFor(secret, nonce) }),
    });
}

async function getToken(): Promise<string> {
    const res = await redeem(await getChallenge());
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
}

const authorized = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

afterEach(async () => {
    vi.useRealTimers();
    await server?.stop();
    server = null;
});

describe('lanServer read-only API', () => {
    it('rejects reads without a token', async () => {
        await start();
        expect((await fetch(url('/lan/sessions'))).status).toBe(401);
        expect((await fetch(url('/lan/identity'))).status).toBe(401);
    });

    it('rejects a malformed or foreign token', async () => {
        await start();
        expect((await fetch(url('/lan/sessions'), authorized('not-a-token'))).status).toBe(401);

        // Structurally valid, but signed with a different secret.
        const token = await getToken();
        const forged = Buffer.from(
            Buffer.from(token, 'base64url').toString('utf8').replace(/\.[^.]+$/, '.deadbeef'),
        ).toString('base64url');
        expect((await fetch(url('/lan/sessions'), authorized(forged))).status).toBe(401);
    });

    it('consumes a nonce even when the proof is wrong, so it cannot be replayed', async () => {
        await start();
        const nonce = await getChallenge();

        expect((await redeem(nonce, WRONG_SECRET)).status).toBe(401);
        // The same nonce is now spent: a correctly-signed retry must also fail.
        expect((await redeem(nonce)).status).toBe(401);
    });

    it('serves identity and the session list to a client that proved possession of the key', async () => {
        await start();
        const token = await getToken();

        const identity = (await (await fetch(url('/lan/identity'), authorized(token))).json()) as {
            v: number;
            machineId: string;
            accountFingerprint: string;
        };
        expect(identity.v).toBe(LAN_PROTOCOL_VERSION);
        expect(identity.machineId).toBe('machine-1');
        expect(identity.accountFingerprint).toBe('acct-fingerprint');

        const body = (await (await fetch(url('/lan/sessions'), authorized(token))).json()) as { sessions: LanSessionSummary[] };
        expect(body.sessions).toEqual(SESSIONS);
    });

    it('rejects a nonce whose redemption window has passed', async () => {
        await start();
        vi.useFakeTimers({ toFake: ['Date'] });
        const nonce = await getChallenge();

        // Past the 30s redemption window, still inside the 90s token lifetime.
        vi.setSystemTime(Date.now() + 31_000);
        expect((await redeem(nonce)).status).toBe(401);
    });

    it('bounds the nonce store instead of growing without limit', async () => {
        // Production values are unreachable in a test: the per-IP limiter fires long before
        // the count cap. The override lets the cap itself be proven.
        await start({ maxTrackedNonces: 2, maxChallengesPerWindow: 100 });

        const first = await getChallenge();
        await getChallenge();
        await getChallenge();

        // The oldest nonce was evicted to keep the store bounded...
        expect((await redeem(first)).status).toBe(401);
        // ...while the newest still works.
        expect((await redeem(await getChallenge())).status).toBe(200);
    });

    it('rate limits an unauthenticated flood of challenges', async () => {
        await start({ maxChallengesPerWindow: 3 });
        expect((await fetch(url('/lan/challenge'), { method: 'POST' })).status).toBe(200);
        expect((await fetch(url('/lan/challenge'), { method: 'POST' })).status).toBe(200);
        expect((await fetch(url('/lan/challenge'), { method: 'POST' })).status).toBe(200);
        expect((await fetch(url('/lan/challenge'), { method: 'POST' })).status).toBe(429);
    });

    it('serves local history with the key wrapped for the account', async () => {
        await start();
        const token = await getToken();

        const res = await fetch(url('/lan/sessions/sess-1/history'), authorized(token));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { v: number; tag: string; dataEncryptionKey: string; entries: unknown };
        expect(body.v).toBe(LAN_PROTOCOL_VERSION);
        expect(body.tag).toBe('tag-1');
        expect(body.dataEncryptionKey).toBe('WRAPPED-KEY');
        expect(body.entries).toEqual(HISTORY.entries);
    });

    it('distinguishes "no history here" from "not authenticated"', async () => {
        await start();
        const token = await getToken();

        // The tag may simply not have been reported yet, so this is a retry-later, not a denial.
        history = null;
        const missing = await fetch(url('/lan/sessions/sess-1/history'), authorized(token));
        expect(missing.status).toBe(404);

        expect((await fetch(url('/lan/sessions/sess-1/history'))).status).toBe(401);
        history = HISTORY;
    });

    it('exposes no mutating route', async () => {
        await start();
        const token = await getToken();

        // The daemon's control server has these unauthenticated on loopback; none of them
        // may exist here. This is the load-bearing assertion that the control surface was
        // not widened by this feature.
        for (const path of ['/lan/spawn-session', '/lan/stop-session', '/lan/stop', '/lan/restart-session']) {
            const res = await fetch(url(path), { method: 'POST', ...authorized(token) });
            expect(res.status, `${path} must not exist`).toBe(404);
        }
    });

    describe('incremental history', () => {
        it('passes the cursor through to the log reader and returns the next one', async () => {
            await start();
            const token = await getToken();

            const res = await fetch(url('/lan/sessions/sess-1/history?since=0:5'), authorized(token));

            expect(lastSince).toBe('0:5');
            const body = (await res.json()) as { cursor: string };
            expect(body.cursor).toBe('0:1');
        });

        it('omits the cursor on a first read', async () => {
            await start();
            const token = await getToken();

            await fetch(url('/lan/sessions/sess-1/history'), authorized(token));

            expect(lastSince).toBeUndefined();
        });
    });

    describe('CORS', () => {
        // A desktop webview enforces CORS where native fetch does not, so without these headers
        // every LAN read fails with an opaque "Load failed" and the channel looks dead on
        // desktop while working on a phone.

        it('answers the preflight instead of 404ing', async () => {
            await start();

            const res = await fetch(url('/lan/session'), {
                method: 'OPTIONS',
                headers: {
                    origin: 'http://localhost:8081',
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'content-type',
                },
            });

            expect(res.status).toBe(204);
            expect(res.headers.get('access-control-allow-origin')).toBe('*');
            expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
            expect(res.headers.get('access-control-allow-methods')).toContain('POST');
        });

        it('allows the browser to read a real response', async () => {
            await start();

            const res = await fetch(url('/lan/identity'), {
                headers: { origin: 'http://localhost:8081' },
            });

            // 401 here is correct — the point is that the caller can read it at all.
            expect(res.status).toBe(401);
            expect(res.headers.get('access-control-allow-origin')).toBe('*');
        });

        it('leaves a request with no origin untouched', async () => {
            await start();

            // Native fetch (iOS/Android) sends no Origin and is not subject to CORS; the header
            // is harmless there, but the request must still authenticate normally.
            const token = await getToken();
            const res = await fetch(url('/lan/identity'), authorized(token));

            expect(res.status).toBe(200);
        });
    });
});
