/**
 * The offline path used to discard 100% of a session's output: the stub's send methods were
 * no-ops. These tests prove the replacement actually persists, survives a restart, and hands
 * over to the reconnected client with byte-identical ciphertext.
 *
 * Real filesystem; only `@/configuration` (temp happy home) and the transports are mocked.
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
    backoff: vi.fn(async (cb: () => Promise<unknown>) => cb()),
    delay: vi.fn(async () => undefined),
}));

import { ApiClient } from '@/api/api';
import { ApiSessionClient } from '@/api/apiSession';
import { decodeBase64, decrypt } from '@/api/encryption';
import { loadOutbox, outboxPath } from '@/api/outboxPersistence';
import { readSessionKey, sessionKeyPath } from '@/api/sessionKeyPersistence';
import { createOfflineSessionStub } from './offlineSessionStub';

const TAG = 'offline-tag';
const KEY = new Uint8Array(32).fill(7);

const envelope = (id: string, text: string) => ({ id, time: 1000, role: 'agent' as const, ev: { t: 'text' as const, text } });

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

function makeSession() {
    return {
        id: 'server-session-id',
        tag: TAG,
        site: 'machine-1',
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
        encryptionKey: KEY,
        encryptionVariant: 'legacy' as const,
    };
}

describe('offline session stub', () => {
    let happyHome: string;

    beforeEach(() => {
        happyHome = mkdtempSync(join(tmpdir(), 'happy-offline-'));
        state.happyHome = happyHome;
        vi.clearAllMocks();
        mockIo.mockReturnValue(mockSocket);
        mockAxiosGet.mockResolvedValue({ data: { sessions: [] } });
        mockSocket.connected = true;
    });

    afterEach(() => {
        rmSync(happyHome, { recursive: true, force: true });
    });

    it('queues outbound messages to the durable outbox instead of dropping them', () => {
        const stub = createOfflineSessionStub({ tag: TAG, site: 'machine-1', encryptionKey: KEY, encryptionVariant: 'legacy' });

        stub.sendSessionProtocolMessage(envelope('env-1', 'hello offline') as never);

        const entries = loadOutbox(TAG).entries;
        expect(entries).toHaveLength(1);
        expect(entries[0].localId).toBe('env-1');
        expect(existsSync(outboxPath(TAG))).toBe(true);

        // Encrypted with the supplied key, stamped with writer identity, and undelivered.
        const record = decrypt(KEY, 'legacy', decodeBase64(entries[0].content)) as {
            content: { sid?: string; site?: string; ev: { text?: string } };
        };
        expect(record.content.ev.text).toBe('hello offline');
        expect(record.content.sid).toBe(TAG);
        expect(record.content.site).toBe('machine-1');
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('hands queued messages to the reconnected client as identical ciphertext', async () => {
        const stub = createOfflineSessionStub({ tag: TAG, site: 'machine-1', encryptionKey: KEY, encryptionVariant: 'legacy' });
        stub.sendSessionProtocolMessage(envelope('env-1', 'one') as never);
        stub.sendSessionProtocolMessage(envelope('env-2', 'two') as never);
        const queued = loadOutbox(TAG).entries.map((e) => e.content);

        // A process death would leave only the file; dropping the stub models that.
        mockAxiosPost.mockResolvedValue({
            data: { messages: [{ id: 'm1', seq: 1, localId: 'env-1', createdAt: 1, updatedAt: 1 }] },
        });
        const reconnected = new ApiSessionClient('fake-token', makeSession());

        await waitFor(() => expect(loadOutbox(TAG).entries).toEqual([]));

        const delivered = mockAxiosPost.mock.calls.flatMap((call: any[]) => (call[1]?.messages ?? []).map((m: any) => m.content));
        // Byte-identical: the client resends what the stub encrypted rather than re-encrypting.
        expect(delivered).toEqual(queued);
        expect(reconnected.isSocketConnected()).toBe(true);
    });

    it('reuses a persisted dataKey key so offline messages stay decryptable', async () => {
        const api = await ApiClient.create({
            token: 'token',
            encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) },
        } as never);

        const first = api.resolveSessionEncryption(TAG);
        expect(first.encryptionVariant).toBe('dataKey');
        expect(existsSync(sessionKeyPath(TAG))).toBe(true);
        expect(readSessionKey(TAG)).toEqual(first.encryptionKey);

        // A later run with the same tag must land on the same key, otherwise anything queued
        // offline would be encrypted with a key nobody can recover.
        const second = api.resolveSessionEncryption(TAG);
        expect(second.encryptionKey).toEqual(first.encryptionKey);
    });

    it('does not persist a key for legacy credentials', async () => {
        const api = await ApiClient.create({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
        } as never);

        const { encryptionKey, encryptionVariant } = api.resolveSessionEncryption(TAG);

        expect(encryptionVariant).toBe('legacy');
        expect(encryptionKey).toEqual(new Uint8Array(32).fill(9));
        // The account secret already lives in access.key; a second copy would only widen exposure.
        expect(existsSync(sessionKeyPath(TAG))).toBe(false);
    });

    it('survives a crash: a fresh client replays what the (discarded) stub queued', async () => {
        createOfflineSessionStub({ tag: TAG, site: 'machine-1', encryptionKey: KEY, encryptionVariant: 'legacy' })
            .sendSessionProtocolMessage(envelope('env-crash', 'survive') as never);

        // Simulate the reconnect building the client for the same tag.
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        const revived = new ApiSessionClient('fake-token', makeSession());

        await waitFor(() => expect(loadOutbox(TAG).entries).toEqual([]));
        expect(mockAxiosPost.mock.calls.flatMap((c: any[]) => c[1].messages).map((m: any) => m.localId)).toContain('env-crash');
    });
});
