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

const { mockIo, mockAxiosGet, mockAxiosPost, mockSocket, state } = vi.hoisted(() => {
    const socket = {
        connected: true,
        connect: vi.fn(),
        on: vi.fn(),
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
import { loadOutbox, outboxPath } from './outboxPersistence';

const TAG = 'test-session-tag';

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
        encryptionKey: new Uint8Array(32),
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

describe('ApiSessionClient outbox durability', () => {
    let happyHome: string;

    beforeEach(() => {
        happyHome = mkdtempSync(join(tmpdir(), 'happy-outbox-cli-'));
        state.happyHome = happyHome;
        vi.clearAllMocks();
        mockIo.mockReturnValue(mockSocket);
        mockAxiosGet.mockResolvedValue({ data: { sessions: [] } });
        mockSocket.connected = true;
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

    it('deletes the outbox file on close when the queue is empty', async () => {
        mockAxiosPost.mockResolvedValue({
            data: { messages: [{ id: 'm1', seq: 1, localId: 'env-clean', createdAt: 1, updatedAt: 1 }] },
        });
        const client = new ApiSessionClient('fake-token', makeSession());
        client.sendSessionProtocolMessage(envelope('env-clean', 'clean') as never);
        await waitFor(() => expect(postedLocalIds()).toEqual(['env-clean']));

        expect(existsSync(outboxPath(TAG))).toBe(true);
        await client.close();
        expect(existsSync(outboxPath(TAG))).toBe(false);
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
