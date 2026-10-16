import { describe, expect, it, vi } from 'vitest';
import {
    sendBatch,
    sendOverDaemonSocket,
    sendOverServerHttp,
    sendOverServerSocket,
    type ServerSendTransport,
} from './ops';

const batch = [{ localId: 'a', content: 'one' }, { localId: 'b', content: 'two' }];

describe('sendOverDaemonSocket', () => {
    it('takes the write as nothing more than a write', () => {
        // The whole reason this outcome exists: a daemon's socket acknowledges nothing, and calling
        // the write a delivery is what made a connection's first message disappear.
        const sent: string[] = [];
        const outcome = sendOverDaemonSocket({
            socket: { send: (m) => { sent.push(m.localId); return true; } },
            sessionId: 'sess-1',
            batch,
            awaitVerdict: () => undefined,
        });
        expect(outcome.kind).toBe('unconfirmed');
        expect(sent).toEqual(['a', 'b']);
    });

    it('hands the caller the wait, rather than a verdict it cannot give', () => {
        const awaited: string[] = [];
        const outcome = sendOverDaemonSocket({
            socket: { send: () => true },
            sessionId: 'sess-1',
            batch,
            awaitVerdict: (localId) => awaited.push(localId),
        });
        expect(outcome.kind).toBe('unconfirmed');
        if (outcome.kind === 'unconfirmed') {
            for (const message of batch) {
                outcome.awaitVerdict(message.localId);
            }
        }
        expect(awaited).toEqual(['a', 'b']);
    });

    it('a socket that refuses part of the batch is not carrying the session', () => {
        // Not "failed": the caller has somewhere else to go, and the entries stay queued either way.
        const outcome = sendOverDaemonSocket({
            socket: { send: (m) => m.localId === 'a' },
            sessionId: 'sess-1',
            batch,
            awaitVerdict: () => { throw new Error('must not be asked to wait for a batch that did not go'); },
        });
        expect(outcome).toEqual({ kind: 'unavailable' });
    });
});

describe('sendOverServerSocket', () => {
    const transport = (over: Partial<ServerSendTransport> = {}): ServerSendTransport => ({
        isConnected: true,
        send: () => undefined,
        request: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        ...over,
    });

    it('settles on the write, because the server echoes it back', () => {
        expect(sendOverServerSocket({ transport: transport(), sessionId: 'sess-1', batch }))
            .toEqual({ kind: 'acked' });
    });

    it('says so when there is no socket, rather than throwing from a batch that never went', () => {
        const send = vi.fn();
        const outcome = sendOverServerSocket({
            transport: transport({ isConnected: false, send }),
            sessionId: 'sess-1',
            batch,
        });
        expect(outcome).toEqual({ kind: 'unavailable' });
        expect(send).not.toHaveBeenCalled();
    });

    it('reports a write that threw, because the caller has an idempotent route to fall back to', () => {
        const error = new Error('socket closed mid-batch');
        const outcome = sendOverServerSocket({
            transport: transport({ send: () => { throw error; } }),
            sessionId: 'sess-1',
            batch,
        });
        expect(outcome).toEqual({ kind: 'failed', error });
    });
});

describe('sendOverServerHttp', () => {
    const transport = (response: { ok: boolean; status?: number; body?: unknown }): ServerSendTransport => ({
        isConnected: true,
        send: () => undefined,
        request: async () => ({
            ok: response.ok,
            status: response.status ?? (response.ok ? 200 : 500),
            json: async () => response.body ?? {},
        }),
    });

    it('reports where the session now stands, from the seqs the server assigned', async () => {
        // The one path that says it: the socket's ack does not, which is why the field is optional
        // rather than a cursor the caller always moves.
        const outcome = await sendOverServerHttp({
            transport: transport({ ok: true, body: { messages: [{ seq: 4 }, { seq: 9 }] } }),
            sessionId: 'sess-1',
            batch,
        });
        expect(outcome).toEqual({ kind: 'acked', advanceTo: 9 });
    });

    it('is acked without a cursor when the server sent no messages back', async () => {
        const outcome = await sendOverServerHttp({
            transport: transport({ ok: true, body: {} }),
            sessionId: 'sess-1',
            batch,
        });
        expect(outcome).toEqual({ kind: 'acked' });
    });

    it('reports a refusal by the server', async () => {
        const outcome = await sendOverServerHttp({
            transport: transport({ ok: false, status: 503 }),
            sessionId: 'sess-1',
            batch,
        });
        expect(outcome.kind).toBe('failed');
    });

    it('reports a transport that never answered', async () => {
        const outcome = await sendOverServerHttp({
            transport: {
                isConnected: true,
                send: () => undefined,
                request: async () => { throw new Error('offline'); },
            },
            sessionId: 'sess-1',
            batch,
        });
        expect(outcome).toEqual({ kind: 'failed', error: new Error('offline') });
    });
});

describe('sendBatch', () => {
    const transport = (over: Partial<ServerSendTransport> = {}): ServerSendTransport => ({
        isConnected: true,
        send: () => undefined,
        request: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        ...over,
    });

    it('stops at the machine when the machine takes it, and never asks the server', async () => {
        // The order is the decision: a session the machine is carrying is written to there, and the
        // server must not also be handed the message — the two would both deliver it.
        const send = vi.fn();
        const result = await sendBatch({
            daemon: { send: () => true },
            server: transport({ send }),
            sessionId: 'sess-1',
            batch,
        });
        expect(result).toEqual({ kind: 'unconfirmed' });
        expect(send).not.toHaveBeenCalled();
    });

    it('falls through to the server when the machine is not carrying the session', async () => {
        // "Unavailable" is not a failure: a socket refusing the batch means somewhere else to go,
        // and the entries stay queued either way.
        const result = await sendBatch({
            daemon: { send: () => false },
            server: transport(),
            sessionId: 'sess-1',
            batch,
        });
        expect(result).toEqual({ kind: 'acked', over: 'socket' });
    });

    it('takes the server socket echo as the answer, with no cursor to move', async () => {
        const result = await sendBatch({ server: transport(), sessionId: 'sess-1', batch });
        expect(result).toEqual({ kind: 'acked', over: 'socket' });
    });

    it('walks on to HTTP when the socket cannot take the batch', async () => {
        // The route below is idempotent on `localId`, so a batch the socket may have half-written
        // is safe to repeat there.
        const requested: string[] = [];
        const result = await sendBatch({
            server: transport({
                isConnected: false,
                request: async (path) => {
                    requested.push(path);
                    return { ok: true, status: 200, json: async () => ({ messages: [{ seq: 7 }] }) };
                },
            }),
            sessionId: 'sess-1',
            batch,
        });
        expect(requested).toHaveLength(1);
        expect(result).toEqual({ kind: 'acked', over: 'http', advanceTo: 7 });
    });

    it('carries the server cursor back, because HTTP is the only rung that knows it', async () => {
        const result = await sendBatch({
            server: transport({
                isConnected: false,
                request: async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ seq: 3 }, { seq: 11 }] }) }),
            }),
            sessionId: 'sess-1',
            batch,
        });
        expect(result).toEqual({ kind: 'acked', over: 'http', advanceTo: 11 });
    });

    it('reports the walk as failed when the last rung fails', async () => {
        // Nothing below HTTP to fall back to, so this is the walk's own failure and the caller
        // reports it rather than inventing another transport.
        const result = await sendBatch({
            server: transport({
                isConnected: false,
                request: async () => { throw new Error('offline'); },
            }),
            sessionId: 'sess-1',
            batch,
        });
        expect(result).toEqual({ kind: 'failed', error: new Error('offline') });
    });
});
