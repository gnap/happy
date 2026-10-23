/**
 * The LAN API is exposed to a hostile-ish shared network, so these tests focus on the parts
 * that are easy to get subtly wrong: nonce single-use, the bounded nonce store, and the fact
 * that no mutation route exists. They run against a real server on an ephemeral port with no
 * daemon and no `configuration`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { startLanServer, lanProofFor, LAN_PROTOCOL_VERSION, type LanHistory, type LanServerHandle, type LanSessionSummary } from './lanServer';
import { accountProofMessage } from './accountProof';

const SECRET = new Uint8Array(32).fill(3);
const WRONG_SECRET = new Uint8Array(32).fill(4);

/**
 * The account, whose key authorises the actions that change something.
 *
 * The machine key is a *transport* credential — every paired device holds it — so a restart is
 * signed by the account instead. A test about what those routes do therefore has to sign like a real
 * caller, which is what `signed` is for; a test about what they refuse can simply not sign.
 */
const ACCOUNT = nacl.sign.keyPair();
const utf8 = (text: string) => new TextEncoder().encode(text);
/** Nonces already spent, so a proof that arrives twice is refused the second time. */
let proofNonces = new Set<string>();
let proofCounter = 0;

/**
 * A request carrying the account's proof of the *action*, which is what the signature covers.
 *
 * The path is not signed any more: it changes with the route a request takes, so the proof names the
 * action and its target instead. The helper still takes the path, because that is how the tests say
 * which action they mean.
 */
function signed(path: string, init: { token?: string; body?: unknown } = {}) {
    const nonce = `nonce-${++proofCounter}`;
    const at = Date.now();
    const isToolContent = path.includes('/tool-content/');
    const operation = isToolContent ? 'tool-content' : path.endsWith('/restart') ? 'restart' : 'control';
    const target = isToolContent
        ? path.split('/tool-content/')[1] ? `${path.split('/sessions/')[1]?.split('/')[0] ?? '-'}:${path.split('/tool-content/')[1]}` : '-'
        : path.split('/sessions/')[1]?.split('/')[0] ?? '-';
    const message = accountProofMessage({ operation, target, nonce, at, bodyDigest: '' });
    return {
        method: isToolContent ? 'GET' : 'POST',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        headers: {
            ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            'x-happy-proof-nonce': nonce,
            'x-happy-proof-at': String(at),
            'x-happy-proof-signature': Buffer.from(nacl.sign.detached(utf8(message), ACCOUNT.secretKey)).toString('base64'),
        },
    };
}

const SESSIONS: LanSessionSummary[] = [
    { happySessionId: 'sess-1', directory: '/work/repo', agent: 'claude', startedBy: 'daemon', isAlive: true },
];

const HISTORY: LanHistory = {
    tag: 'tag-1',
    dataEncryptionKey: 'WRAPPED-KEY',
    entries: [{ id: 'id-1', localId: 'local-1', dir: 'out', at: 1, c: 'CIPHER-1' }],
    cursor: '0:1',
    older: '0:0',
    hasNewer: false,
    hasOlder: false,
    reset: false,
};
/** Mutable so a test can simulate a session whose history this machine does not have. */
let history: LanHistory | null = HISTORY;
/** What the route passed down, so the anchor plumbing can be asserted rather than assumed. */
let lastQuery: { since?: string; before?: string } | undefined;
/** How the route named the session, so the two addresses can be told apart. */
let lastAddress: { sessionId?: string; tag?: string } | undefined;
/** Messages the socket handed to the daemon, in order. */
let sent: { sessionId: string; localId: string; content: string }[] = [];
/** Sessions the restart route asked to restart. */
let restarted: string[] = [];
/** Control calls the route forwarded, in order. */
let controlled: { sessionId: string; method: string; params: string }[] = [];
/** Whether the wired daemon claims a live session for the id it is handed. */
let liveSessions: Set<string> = new Set(['sess-1']);
/** The daemon's lifecycle log, as the route reads it. */
let lifecycleEntries: { rev: number; op: string; tag: string }[] = [];
/** The full tool payload this machine can read; unset by default, like a daemon from before the route. */
let toolContentHandler: ((args: { sessionId: string; callId: string }) => Promise<{ args?: unknown; result?: unknown } | null>) | undefined;
/** Left unset by default, which is how a daemon that predates the route behaves. */
let restartHandler: ((sessionId: string) => Promise<{ success: boolean; newSessionId?: string; error?: string }>) | undefined;

let server: LanServerHandle | null = null;
/** What a socket reader should be handed on connect; mutable so one test can set it. */
let snapshot: unknown[] = [];

async function start(limits?: Parameters<typeof startLanServer>[0]['limits']) {
    server = await startLanServer({
        secret: SECRET,
        machineId: 'machine-1',
        accountFingerprint: 'acct-fingerprint',
        getSessions: () => SESSIONS,
        getHistory: (address, query) => {
            lastQuery = query;
            lastAddress = address;
            return history;
        },
        onSend: (message) => {
            sent.push(message);
        },
        // Only when a test asked for it: a daemon without the handler is a daemon from before the
        // route existed, and the 404 it answers is what sends a caller to the server instead.
        ...(restartHandler ? { restartSession: restartHandler } : {}),
        ...(toolContentHandler ? { getToolContent: toolContentHandler } : {}),
        lifecycle: {
            revision: () => lifecycleEntries.length,
            entriesSince: (since: number) => lifecycleEntries.filter((entry) => entry.rev > since),
        },
        onSessionControl: ({ sessionId, method, params }) => {
            if (!liveSessions.has(sessionId)) {
                return false;
            }
            controlled.push({ sessionId, method, params });
            return true;
        },
        getSnapshot: () => snapshot,
        // A daemon that cannot check a proof refuses the routes that need one rather than accepting
        // them on the machine key alone, so the check is part of the surface these tests exercise.
        accountProof: {
            verify: (message, signature) => nacl.sign.detached.verify(utf8(message), Buffer.from(signature, 'base64'), ACCOUNT.publicKey),
            nonceSeen: (nonce) => proofNonces.has(nonce),
            rememberNonce: (nonce) => { proofNonces.add(nonce); },
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
    restarted = [];
    controlled = [];
    liveSessions = new Set(['sess-1']);
    lifecycleEntries = [];
    restartHandler = undefined;
    toolContentHandler = undefined;
    proofNonces = new Set();
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

    it('answers a reachability question without minting a credential for it', async () => {
        // A probe asks this every 30 seconds per machine per device and discards the answer. Answering
        // it with a challenge spent a nonce each time — a credential issued to be thrown away, held in
        // the nonce store until it expired, and counted against the flood limit above.
        await start({ maxTrackedNonces: 1, maxChallengesPerWindow: 1 });
        for (let i = 0; i < 5; i += 1) {
            const res = await fetch(url('/lan/ping'));
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ ok: true });
        }
        // The store and the challenge budget are untouched: a challenge still works afterwards.
        expect((await fetch(url('/lan/challenge'), { method: 'POST' })).status).toBe(200);
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

    /**
     * The tag is the CLI's own identity: it exists before the server has answered, so a session
     * waiting out a server stall is reachable this way and not the other.
     */
    it('serves the same history when addressed by tag instead of session id', async () => {
        await start();
        const token = await getToken();

        const res = await fetch(url('/lan/tags/tag-1/history'), authorized(token));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ v: LAN_PROTOCOL_VERSION, ...HISTORY });
        // Addressed by tag, not by id -- that is the whole point of the route.
        expect(lastAddress).toEqual({ tag: 'tag-1' });

        expect((await fetch(url('/lan/tags/tag-1/history'))).status).toBe(401);
    });

    it('reports a tag it has no history for the same way as a session it does not know', async () => {
        await start();
        const token = await getToken();

        history = null;
        const missing = await fetch(url('/lan/tags/unknown-tag/history'), authorized(token));
        expect(missing.status).toBe(404);
        history = HISTORY;
    });

    it('exposes no machine-level control route', async () => {
        await start();
        const token = await getToken();

        // The daemon's control server has these unauthenticated on loopback; none of them may
        // exist here. What this pins is that the surface stops at the session: nothing reachable
        // from here starts a session that was not already one, stops the daemon, or shuts the
        // machine down. The one session-scoped action that does exist is tested below.
        for (const path of ['/lan/spawn-session', '/lan/stop-session', '/lan/stop', '/lan/restart-session']) {
            const res = await fetch(url(path), { method: 'POST', ...authorized(token) });
            expect(res.status, `${path} must not exist`).toBe(404);
        }
    });

    describe('restarting a session', () => {
        it('hands the session to the daemon and returns its verdict', async () => {
            restartHandler = async (sessionId) => {
                restarted.push(sessionId);
                return { success: true, newSessionId: 'sess-1-restarted' };
            };
            await start();
            const token = await getToken();

            const res = await fetch(url('/lan/sessions/sess-1/restart'), signed('/lan/sessions/sess-1/restart', { token }));

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ v: 1, success: true, newSessionId: 'sess-1-restarted' });
            expect(restarted).toEqual(['sess-1']);
        });

        it('reports a refusal as an answer, not as an unroutable request', async () => {
            // A refusal is this machine's verdict and the caller must not go and ask the server the
            // same question: the two routes call the same handler, so it would come back the same
            // way, and in between a restart that was refused would look like one that was attempted.
            restartHandler = async () => ({ success: false, error: 'Session has been archived and cannot be restarted' });
            await start();
            const token = await getToken();

            const res = await fetch(url('/lan/sessions/sess-1/restart'), signed('/lan/sessions/sess-1/restart', { token }));

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
                v: 1,
                success: false,
                error: 'Session has been archived and cannot be restarted',
            });
        });

        it('is not reachable without a token', async () => {
            restartHandler = async (sessionId) => {
                restarted.push(sessionId);
                return { success: true };
            };
            await start();

            const res = await fetch(url('/lan/sessions/sess-1/restart'), { method: 'POST' });

            expect(res.status).toBe(401);
            expect(restarted).toEqual([]);
        });

        it('says so when the daemon does not offer it, so the caller can use the server instead', async () => {
            // The shape an older daemon has. A 404 here is not "no such session" — it is "this
            // build has no such route", which is a reason to try another route rather than to
            // report a failure.
            await start();
            const token = await getToken();

            const res = await fetch(url('/lan/sessions/sess-1/restart'), signed('/lan/sessions/sess-1/restart', { token }));

            expect(res.status).toBe(404);
        });

        // Skipped, not deleted: the account check is off until the App sends its proof under its own
        // header names — it refused every request through the relay, because the App's machine-key
        // proof was being checked against the account's public key. This is the test to un-skip when
        // the check comes back.
        it.skip('refuses a restart the machine key alone can ask for, which is the whole distinction', async () => {
            // Holding the machine key means "can connect", not "may start a process": every paired
            // device has it, and a key holder can derive the relay tag and arrive that way too — so
            // this cannot be a per-channel rule and it is checked on the route.
            restartHandler = async (sessionId) => {
                restarted.push(sessionId);
                return { success: true };
            };
            await start();
            const token = await getToken();

            const unsigned = await fetch(url('/lan/sessions/sess-1/restart'), { method: 'POST', ...authorized(token) });
            expect(unsigned.status).toBe(403);
            expect(restarted).toEqual([]);

            // And a signature that has already been used is not a second authorisation.
            const first = signed('/lan/sessions/sess-1/restart', { token });
            expect((await fetch(url('/lan/sessions/sess-1/restart'), first)).status).toBe(200);
            expect((await fetch(url('/lan/sessions/sess-1/restart'), first)).status).toBe(403);
            expect(restarted).toEqual(['sess-1']);
        });
    });

    describe('incremental history', () => {
        it('passes the anchor through to the log reader and returns the page edges', async () => {
            await start();
            const token = await getToken();

            const res = await fetch(url('/lan/sessions/sess-1/history?since=0:5'), authorized(token));

            expect(lastQuery).toEqual({ since: '0:5', before: undefined });
            const body = (await res.json()) as { cursor: string; older: string };
            expect(body.cursor).toBe('0:1');
            expect(body.older).toBe('0:0');
        });

        it('passes `before` through, so a reader can page back', async () => {
            await start();
            const token = await getToken();

            await fetch(url('/lan/sessions/sess-1/history?before=2:9'), authorized(token));

            expect(lastQuery).toEqual({ since: undefined, before: '2:9' });
        });

        it('asks for no anchor at all on a first read, which means the newest page', async () => {
            await start();
            const token = await getToken();

            await fetch(url('/lan/sessions/sess-1/history'), authorized(token));

            expect(lastQuery).toEqual({ since: undefined, before: undefined });
        });
    });

    describe('sending over the socket', () => {
        // The socket is deliberately a write surface, unlike the read-only HTTP API. What bounds
        // it is that the caller already proved possession of the machine key at the upgrade, and
        // the only thing a send can do is hand a user message to a session — the same act the
        // server route performs. There is no spawn/stop/shutdown reachable from here.

        async function connectSocket(): Promise<WebSocket> {
            const { nonce } = await (await fetch(url('/lan/challenge'), { method: 'POST' })).json() as { nonce: string };
            const proof = lanProofFor(SECRET, nonce);
            const socket = new WebSocket(
                `ws://127.0.0.1:${server!.port}/lan/socket?nonce=${encodeURIComponent(nonce)}&proof=${encodeURIComponent(proof)}`,
            );
            await new Promise<void>((resolve, reject) => {
                socket.addEventListener('open', () => resolve());
                socket.addEventListener('close', () => reject(new Error('socket refused')));
            });
            return socket;
        }

        it('hands a sent message to the daemon with its ciphertext intact', async () => {
            await start();
            sent = [];
            const socket = await connectSocket();

            socket.send(JSON.stringify({
                event: 'send',
                payload: { sessionId: 'sess-1', localId: 'local-9', content: 'CIPHER-9' },
            }));
            await new Promise((resolve) => setTimeout(resolve, 50));
            socket.close();

            expect(sent).toEqual([{ sessionId: 'sess-1', localId: 'local-9', content: 'CIPHER-9' }]);
        });

        it('replays the current session state to a reader that connects late', async () => {
            await start();
            const envelope = { id: 'lan-1', seq: 0, body: { t: 'update-session', id: 'sess-1' }, createdAt: 1 };
            snapshot = [envelope];
            const { nonce } = await (await fetch(url('/lan/challenge'), { method: 'POST' })).json() as { nonce: string };
            const socket = new WebSocket(
                `ws://127.0.0.1:${server!.port}/lan/socket?nonce=${encodeURIComponent(nonce)}&proof=${encodeURIComponent(lanProofFor(SECRET, nonce))}`,
            );
            const first = await new Promise<string>((resolve, reject) => {
                socket.addEventListener('message', (event) => resolve(String(event.data)));
                socket.addEventListener('close', () => reject(new Error('socket refused')));
            });
            socket.close();
            snapshot = [];

            expect(JSON.parse(first)).toEqual({ event: 'update', payload: envelope });
        });

        it('ignores a frame that is not a send, and a send that is missing fields', async () => {
            await start();
            sent = [];
            const socket = await connectSocket();

            socket.send(JSON.stringify({ event: 'subscribe', payload: { sessionId: 'sess-1' } }));
            socket.send(JSON.stringify({ event: 'send', payload: { sessionId: 'sess-1' } }));
            socket.send('not json at all');
            await new Promise((resolve) => setTimeout(resolve, 50));
            socket.close();

            expect(sent).toEqual([]);
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

describe('control calls inside a running session', () => {
    const control = (token: string, sessionId: string, body: unknown) =>
        fetch(url(`/lan/sessions/${sessionId}/control`), signed(`/lan/sessions/${sessionId}/control`, { token, body }));

    it('forwards an abort or a permission answer to the session, ciphertext and all', async () => {
        await start();
        const token = await getToken();

        expect((await control(token, 'sess-1', { method: 'abort', params: 'AAA' })).status).toBe(200);
        expect((await control(token, 'sess-1', { method: 'permission', params: 'BBB' })).status).toBe(200);
        // What the daemon was handed and what it forwards are the same bytes: it never holds the
        // session's key, so the parameters stay the caller's ciphertext all the way through.
        expect(controlled).toEqual([
            { sessionId: 'sess-1', method: 'abort', params: 'AAA' },
            { sessionId: 'sess-1', method: 'permission', params: 'BBB' },
        ]);
    });

    it('says so when no live session has that id, rather than looking like it acted', async () => {
        // The one thing the caller has to be told apart: it cannot otherwise tell "the session did
        // it" from "nobody was asked", and the way it finds out is by asking the server instead.
        await start();
        const token = await getToken();

        expect((await control(token, 'sess-unknown', { method: 'abort', params: 'AAA' })).status).toBe(404);
        expect(controlled).toEqual([]);
    });

    it('refuses a method this API does not forward, which is where the boundary is written', async () => {
        // The daemon's own API starts sessions, stops them and runs things inside them — and none of
        // that is reachable from here. Aborting a turn and answering a prompt are the ones that only
        // move a session that is already running.
        await start();
        const token = await getToken();

        for (const method of ['spawn', 'stop', 'exec', 'switch']) {
            expect((await control(token, 'sess-1', { method, params: 'AAA' })).status, method).toBe(400);
        }
        expect(controlled).toEqual([]);
    });

    it('is not reachable without a token, and insists on parameters it can forward', async () => {
        await start();
        const token = await getToken();

        expect((await fetch(url('/lan/sessions/sess-1/control'), { method: 'POST' })).status).toBe(401);
        expect((await control(token, 'sess-1', { method: 'abort' })).status).toBe(400);
        expect(controlled).toEqual([]);
    });
});

describe('the lifecycle log over the LAN', () => {
    const lifecycle = (token: string, query = '') => fetch(url(`/lan/lifecycle${query}`), { headers: { authorization: `Bearer ${token}` } });

    it('hands a reader everything after its own cursor, and where the log now stands', async () => {
        // How far the log has been replayed is the *reader's* business, which is what lets one
        // channel be at the newest entry while another is still catching up.
        lifecycleEntries = [
            { rev: 1, op: 'created', tag: 'a' },
            { rev: 2, op: 'created', tag: 'b' },
            { rev: 3, op: 'deleted', tag: 'a' },
        ];
        await start();
        const token = await getToken();

        const fresh = await (await lifecycle(token)).json() as { revision: number; entries: unknown[] };
        expect(fresh.revision).toBe(3);
        expect(fresh.entries).toHaveLength(3);

        const caughtUp = await (await lifecycle(token, '?since=2')).json() as { entries: { tag: string }[] };
        expect(caughtUp.entries.map((entry) => entry.tag)).toEqual(['a']);
        // A cursor at the end is a reader with nothing to do, not an error.
        expect(((await (await lifecycle(token, '?since=3')).json()) as { entries: unknown[] }).entries).toEqual([]);
    });

    it('is a route of its own, not a field on the session list', async () => {
        // The summary is a snapshot of what exists; this is an ordered list of facts. A reader that
        // wants to know what changed asks here.
        lifecycleEntries = [{ rev: 1, op: 'created', tag: 'a' }];
        await start();
        const token = await getToken();

        const summary = await (await fetch(url('/lan/sessions'), authorized(token))).json() as Record<string, unknown>;
        expect(summary).not.toHaveProperty('entries');
        expect(summary).not.toHaveProperty('revision');
    });

    it('is not reachable without a token', async () => {
        await start();
        expect((await fetch(url('/lan/lifecycle'))).status).toBe(401);
    });
});

describe('lanServer tool content', () => {
    const CONTENT = { args: { command: 'ls' }, result: { stdout: 'x'.repeat(50_000) } };

    beforeEach(() => {
        toolContentHandler = async ({ sessionId, callId }) =>
            sessionId === 'sess-1' && callId === 'call-1' ? CONTENT : null;
    });

    it('serves the full payload to the account', async () => {
        await start();
        const token = await getToken();

        const res = await fetch(
            url('/lan/sessions/sess-1/tool-content/call-1'),
            signed('/lan/sessions/sess-1/tool-content/call-1', { token }) as RequestInit,
        );

        expect(res.status).toBe(200);
        const body = await res.json() as { args?: unknown; result?: { stdout?: string } };
        expect(body.args).toEqual({ command: 'ls' });
        expect(body.result?.stdout).toHaveLength(50_000);
    });

    it('refuses the plaintext payload without the account proof', async () => {
        await start();
        const token = await getToken();

        // The machine key is a transport credential every paired device holds; this content can be
        // a working tree's secrets, so it is the account that has to ask for it.
        const res = await fetch(url('/lan/sessions/sess-1/tool-content/call-1'), authorized(token));

        expect(res.status).toBe(403);
    });

    it('refuses a call id that could leave the content directory', async () => {
        await start();
        const token = await getToken();
        const path = '/lan/sessions/sess-1/tool-content/..%2F..%2Fetc%2Fpasswd';

        const res = await fetch(url(path), signed(path, { token }) as RequestInit);

        expect(res.status).toBe(400);
    });

    it('answers 404 for a call this machine does not have', async () => {
        await start();
        const token = await getToken();
        const path = '/lan/sessions/sess-1/tool-content/call-2';

        const res = await fetch(url(path), signed(path, { token }) as RequestInit);

        expect(res.status).toBe(404);
    });
});
