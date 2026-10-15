import { describe, expect, it, vi } from 'vitest';
import {
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
