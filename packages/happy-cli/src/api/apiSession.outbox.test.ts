/**
 * Durability tests for the outgoing message queue.
 *
 * These deliberately use the REAL filesystem (the sibling `apiSession.test.ts` mocks
 * `node:fs`, which makes every write a no-op and would turn these into tests that only
 * prove the code ran). Only `@/configuration` is mocked, to point the happy home at a
 * per-test temp directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockIo, mockAxiosGet, mockAxiosPost, mockSocket, socketHandlers, state } = vi.hoisted(() => {
    const handlers: Record<string, Array<(...args: any[]) => void>> = {};
    const socket = {
        connected: true,
        connect: vi.fn(),
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
            (handlers[event] ||= []).push(handler);
        }),
        off: vi.fn(),
        emit: vi.fn(),
        emitWithAck: vi.fn(async () => ({ result: 'error' })),
        volatile: { emit: vi.fn() },
        close: vi.fn(),
    };
    return {
        mockIo: vi.fn(() => socket),
        mockAxiosGet: vi.fn(),
        mockAxiosPost: vi.fn(),
        mockSocket: socket,
        socketHandlers: handlers,
        state: { happyHome: '/tmp/happy-test-home' },
    };
});

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://server.test',
        get happyHomeDir() {
            return state.happyHome;
        },
    },
    serverHttpsAgent: {},
}));

vi.mock('socket.io-client', () => ({ io: mockIo }));

vi.mock('axios', () => ({
    default: {
        get: mockAxiosGet,
        post: mockAxiosPost,
        isAxiosError: (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        registerHandler = vi.fn();
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
    },
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));

// The daemon link is what a LAN reader actually receives from, so it is stubbed rather than
// left to fail silently: the point of these tests is the frame, not the socket.
const { mockForward } = vi.hoisted(() => ({ mockForward: vi.fn(() => true) }));
vi.mock('@/daemon/unixSocketClient', () => ({ forwardSessionEventToDaemon: mockForward }));

vi.mock('@/utils/time', () => ({
    // Fewer iterations than the real unbounded loop, and it resolves rather than throws:
    // the real one retries forever, so a throw here would surface as an unhandled
    // rejection when the queue legitimately stays put because the server is down.
    backoff: vi.fn(async (cb: () => Promise<unknown>) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await cb();
            } catch {
                /* retry */
            }
        }
        return undefined;
    }),
    delay: vi.fn(async () => undefined),
}));

import { ApiSessionClient } from './apiSession';
import { loadOutbox, outboxPath, saveOutbox } from './outboxPersistence';
import { readSessionLog } from './sessionLog';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';

const TAG = 'test-session-tag';
/** Shared so a second client for the same tag can decrypt what the first one posted. */
const SESSION_KEY = new Uint8Array(32).fill(5);

function makeSession() {
    return {
        id: 'test-session-id',
        tag: TAG,
        site: 'test-machine-id',
        seq: 0,
        metadata: {
            path: '/tmp',
            host: 'localhost',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib',
            happyToolsDir: '/home/user/.happy/tools',
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: SESSION_KEY,
        encryptionVariant: 'legacy' as const,
    };
}

const envelope = (id: string, text: string) => ({
    id,
    time: 1000,
    role: 'agent' as const,
    ev: { t: 'text' as const, text },
});

async function waitFor(check: () => void, timeoutMs = 3000) {
    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            check();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw lastError;
}

/** localIds of every message ever POSTed, in order. */
const postedLocalIds = () =>
    mockAxiosPost.mock.calls.flatMap((call: any[]) => (call[1]?.messages ?? []).map((m: any) => m.localId));

/** The `n` each posted envelope carries, read out of its ciphertext. */
const postedEnvelopeNs = () =>
    mockAxiosPost.mock.calls.flatMap((call: any[]) =>
        (call[1]?.messages ?? []).map((m: any) => {
            const record = decrypt(SESSION_KEY, 'legacy', decodeBase64(m.content)) as { content?: { n?: number } };
            return record.content?.n;
        })
    );

/** A socket update carrying one encrypted message, in the shape the server sends. */
function newMessageUpdate(seq: number, ct: string) {
    return {
        id: `upd-${seq}`,
        seq,
        createdAt: 1,
        body: {
            t: 'new-message',
            sid: 'test-session-id',
            message: { id: `msg-${seq}`, seq, localId: null, content: { t: 'encrypted', c: ct }, createdAt: 1, updatedAt: 1 },
        },
    };
}

const emitSocketEvent = (event: string, payload: unknown) => {
    for (const handler of socketHandlers[event] ?? []) handler(payload);
};

const loggedEntries = (dir: 'in' | 'out') =>
    readSessionLog(TAG, 'test-machine-id').filter((e) => e.dir === dir);

describe('ApiSessionClient local message log', () => {
    let happyHome: string;

    beforeEach(() => {
        happyHome = mkdtempSync(join(tmpdir(), 'happy-log-cli-'));
        state.happyHome = happyHome;
        vi.clearAllMocks();
        mockIo.mockReturnValue(mockSocket);
        mockAxiosGet.mockResolvedValue({ data: { sessions: [] } });
        mockSocket.connected = true;
        for (const key of Object.keys(socketHandlers)) {
            delete socketHandlers[key];
        }
    });

    afterEach(() => {
        rmSync(happyHome, { recursive: true, force: true });
    });

    it('logs an incoming message once, even when a second delivery path replays the same seq', () => {
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        const client = new ApiSessionClient('fake-token', makeSession());
        // Caught up, so seq 6 takes the socket fast path rather than the HTTP catch-up.
        (client as unknown as { lastSeq: number }).lastSeq = 5;

        const body = { role: 'user', content: { type: 'text', text: 'hello' } };
        const ct = encodeBase64(encrypt(SESSION_KEY, 'legacy', body));

        emitSocketEvent('update', newMessageUpdate(6, ct));
        expect(loggedEntries('in')).toHaveLength(1);
        expect(loggedEntries('in')[0].c).toBe(ct);

        // Replay the same seq, as the HTTP catch-up funnel would. The log is written inside
        // routeIncomingMessage, after its seq dedup -- hooking the call sites instead would
        // record this message twice.
        (client as unknown as { routeIncomingMessage: (m: unknown) => void }).routeIncomingMessage({
            body,
            seq: 6,
            ct,
            id: 'msg-6',
            localId: null,
        });
        expect(loggedEntries('in')).toHaveLength(1);
    });

    it('logs outbound messages with the ciphertext that actually went on the wire', async () => {
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        const client = new ApiSessionClient('fake-token', makeSession());
        client.sendSessionProtocolMessage(envelope('env-out', 'out') as never);
        await waitFor(() => expect(postedLocalIds()).toEqual(['env-out']));

        const posted = mockAxiosPost.mock.calls.flatMap((call: any[]) => call[1].messages).map((m: any) => m.content);
        const logged = loggedEntries('out');
        expect(logged.map((e) => e.id)).toEqual(['env-out']);
        expect(logged[0].c).toBe(posted[0]);
    });

    it('mirrors each outbound entry to the daemon as a log-entry frame, ciphertext included', async () => {
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        const client = new ApiSessionClient('fake-token', makeSession());
        client.sendSessionProtocolMessage(envelope('env-lan', 'for the LAN') as never);
        await waitFor(() => expect(loggedEntries('out')).toHaveLength(1));

        const mirrored = mockForward.mock.calls
            .map((call: any[]) => call[0])
            .filter((event: any) => event?.t === 'log-entry');

        // The frame is the entry itself, not a hint that one exists: a reader that applies it and
        // one that reads the log converge on the same bytes, which is what lets the LAN channel
        // deliver messages without an extra fetch.
        const logged = loggedEntries('out')[0];
        expect(mirrored).toEqual([
            {
                t: 'log-entry',
                id: 'test-session-id',
                entry: { id: 'env-lan', localId: 'env-lan', dir: 'out', at: logged.at, c: logged.c },
            },
        ]);
    });

    it('keeps the log across a restart and appends to it rather than starting over', () => {
        mockAxiosPost.mockRejectedValue(new Error('ECONNREFUSED'));
        const first = new ApiSessionClient('fake-token', makeSession());
        first.sendSessionProtocolMessage(envelope('env-log-1', 'persisted') as never);
        expect(loggedEntries('out').map((e) => e.id)).toEqual(['env-log-1']);

        // Unlike the outbox, the log is not pruned on session start -- it is history.
        const second = new ApiSessionClient('fake-token', makeSession());
        second.sendSessionProtocolMessage(envelope('env-log-2', 'more') as never);
        expect(loggedEntries('out').map((e) => e.id)).toEqual(['env-log-1', 'env-log-2']);
    });
});

describe('ApiSessionClient outbox durability', () => {
    let happyHome: string;

    beforeEach(() => {
        happyHome = mkdtempSync(join(tmpdir(), 'happy-outbox-cli-'));
        state.happyHome = happyHome;
        vi.clearAllMocks();
        mockIo.mockReturnValue(mockSocket);
        mockAxiosGet.mockResolvedValue({ data: { sessions: [] } });
        mockSocket.connected = true;
        for (const key of Object.keys(socketHandlers)) {
            delete socketHandlers[key];
        }
    });

    afterEach(() => {
        rmSync(happyHome, { recursive: true, force: true });
    });

    it('persists queued messages and resends them after a restart, in order', async () => {
        // The server is unreachable, so nothing drains and the queue stays put.
        mockAxiosPost.mockRejectedValue(new Error('ECONNREFUSED'));
        const first = new ApiSessionClient('fake-token', makeSession());
        first.sendSessionProtocolMessage(envelope('env-1', 'one') as never);
        first.sendSessionProtocolMessage(envelope('env-2', 'two') as never);
        await waitFor(() => expect(mockAxiosPost).toHaveBeenCalled());

        // The write path mirrored the queue to disk...
        expect(loadOutbox(TAG).entries.map((e) => e.localId)).toEqual(['env-1', 'env-2']);
        // ...and nothing was accepted: the HTTP path only splices after the response
        // resolves, so a still-populated queue proves the server took delivery of nothing.
        expect((first as unknown as { pendingOutbox: unknown[] }).pendingOutbox).toHaveLength(2);

        // Stop the retry loop; the queue is non-empty so the file survives the shutdown.
        await first.close();

        // A fresh client for the same tag, as a restarted process would build.
        mockAxiosPost.mockReset();
        mockAxiosPost.mockResolvedValue({
            data: { messages: [{ id: 'm1', seq: 1, localId: 'env-1', createdAt: 1, updatedAt: 1 }] },
        });

        const second = new ApiSessionClient('fake-token', makeSession());
        expect((second as unknown as { pendingOutbox: Array<{ localId: string }> }).pendingOutbox.map((e) => e.localId))
            .toEqual(['env-1', 'env-2']);

        await waitFor(() => expect(postedLocalIds()).toEqual(['env-1', 'env-2']));

        // The queue is now empty, so the file is not needed any more.
        expect(loadOutbox(TAG).entries).toEqual([]);
    });

    it('queues a LAN-delivered user message for the server once, under the App\'s localId', async () => {
        mockAxiosPost.mockResolvedValue({ data: { messages: [{ id: 'm1', seq: 1, localId: 'app-1', createdAt: 1, updatedAt: 1 }] } });
        const client = new ApiSessionClient('fake-token', makeSession());
        const content = encodeBase64(encrypt(SESSION_KEY, 'legacy', { role: 'user', content: { type: 'text', text: 'hi' } }));

        expect(client.deliverLanUserMessage({ localId: 'app-1', content })).toBe(true);
        // The same frame arriving again must not queue a second copy.
        expect(client.deliverLanUserMessage({ localId: 'app-1', content })).toBe(true);

        await waitFor(() => expect(postedLocalIds()).toEqual(['app-1']));
        const posted = mockAxiosPost.mock.calls.flatMap((call: any[]) => call[1]?.messages ?? []);
        expect(posted[0].content).toBe(content);
    });

    it('does not queue a LAN message that fails to decrypt', async () => {
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        const client = new ApiSessionClient('fake-token', makeSession());
        const bad = encodeBase64(encrypt(new Uint8Array(32).fill(9), 'legacy', { role: 'user' }));

        expect(client.deliverLanUserMessage({ localId: 'app-2', content: bad })).toBe(false);
        expect((client as unknown as { pendingOutbox: unknown[] }).pendingOutbox).toHaveLength(0);
    });

    it('drains restored messages over HTTP even when the socket is connected', async () => {
        // Leave a queue behind, as a crashed process would.
        const seeded = new ApiSessionClient('fake-token', makeSession());
        mockAxiosPost.mockRejectedValue(new Error('ECONNREFUSED'));
        seeded.sendSessionProtocolMessage(envelope('env-seed', 'seed') as never);
        await waitFor(() => expect(loadOutbox(TAG).entries.length).toBe(1));
        await seeded.close();

        mockAxiosPost.mockReset();
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });

        const restored = new ApiSessionClient('fake-token', makeSession());
        // The WS path removes optimistically with no server ack, so durable entries must
        // not go through it.
        expect((restored as unknown as { shouldFlushOutboxViaWs: () => boolean }).shouldFlushOutboxViaWs()).toBe(false);

        await waitFor(() => expect(mockAxiosPost).toHaveBeenCalled());
        expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.anything());
    });

    it('keeps the writer-state file on close even when the queue is empty', async () => {
        mockAxiosPost.mockResolvedValue({
            data: { messages: [{ id: 'm1', seq: 1, localId: 'env-clean', createdAt: 1, updatedAt: 1 }] },
        });
        const client = new ApiSessionClient('fake-token', makeSession());
        client.sendSessionProtocolMessage(envelope('env-clean', 'clean') as never);
        await waitFor(() => expect(postedLocalIds()).toEqual(['env-clean']));

        expect(existsSync(outboxPath(TAG))).toBe(true);
        await client.close();
        // The file is session writer state, not just a queue: it carries the envelope
        // counter, and a resumed tag must continue counting rather than reissue values.
        expect(existsSync(outboxPath(TAG))).toBe(true);
    });

    it('continues the envelope counter across a restart with an empty queue', async () => {
        mockAxiosPost.mockResolvedValue({
            data: { messages: [{ id: 'm1', seq: 1, localId: 'env-1', createdAt: 1, updatedAt: 1 }] },
        });
        const first = new ApiSessionClient('fake-token', makeSession());
        first.sendSessionProtocolMessage(envelope('env-1', 'one') as never);
        first.sendSessionProtocolMessage(envelope('env-2', 'two') as never);
        await waitFor(() => expect(postedLocalIds()).toHaveLength(2));

        expect(postedEnvelopeNs()).toEqual([0, 1]);
        expect(loadOutbox(TAG).nextN).toBe(2);

        // A clean close leaves the queue empty -- the case where the counter used to be
        // deleted along with the file.
        await first.close();
        mockAxiosPost.mockReset();
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });

        const second = new ApiSessionClient('fake-token', makeSession());
        second.sendSessionProtocolMessage(envelope('env-3', 'three') as never);
        await waitFor(() => expect(postedLocalIds()).toEqual(['env-3']));

        // Must resume at 2, not restart at 0.
        expect(postedEnvelopeNs()).toEqual([2]);
    });

    it('does not reissue a counter value when an undelivered envelope is resent', async () => {
        // Seed state as a killed process would have left it: entry n=4, counter at 5.
        const seededEnvelope = {
            id: 'env-seeded',
            time: 1,
            role: 'agent' as const,
            ev: { t: 'text' as const, text: 'seeded' },
            sid: TAG,
            site: 'test-machine-id',
            n: 4,
        };
        saveOutbox(TAG, {
            entries: [{ localId: 'env-seeded', content: encodeBase64(encrypt(SESSION_KEY, 'legacy', { role: 'session', content: seededEnvelope, meta: { sentFrom: 'cli' } })) }],
            nextN: 5,
            site: 'test-machine-id',
        });

        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        new ApiSessionClient('fake-token', makeSession());
        await waitFor(() => expect(postedLocalIds()).toEqual(['env-seeded']));

        // The resent envelope keeps its original n, and the counter is not advanced past it.
        expect(postedEnvelopeNs()).toEqual([4]);
        expect(loadOutbox(TAG).nextN).toBe(5);
    });

    it('restarts the counter when the same tag is resumed by a different writer', async () => {
        saveOutbox(TAG, { entries: [], nextN: 7, site: 'some-other-machine' });

        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        const client = new ApiSessionClient('fake-token', makeSession());
        client.sendSessionProtocolMessage(envelope('env-after-move', 'moved') as never);
        await waitFor(() => expect(postedLocalIds()).toEqual(['env-after-move']));

        // Inheriting 7 would interleave two writers' counter ranges under one session.
        expect(postedEnvelopeNs()).toEqual([0]);
    });

    it('keeps the outbox file on close when messages are still queued', async () => {
        mockAxiosPost.mockRejectedValue(new Error('ECONNREFUSED'));
        const client = new ApiSessionClient('fake-token', makeSession());
        client.sendSessionProtocolMessage(envelope('env-stuck', 'stuck') as never);
        await waitFor(() => expect(loadOutbox(TAG).entries.length).toBe(1));

        await client.close();
        expect(existsSync(outboxPath(TAG))).toBe(true);
        expect(loadOutbox(TAG).entries.map((e) => e.localId)).toEqual(['env-stuck']);
    });
});
