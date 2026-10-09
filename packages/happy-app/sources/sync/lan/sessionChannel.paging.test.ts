import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchHistory = vi.fn();
const decryptLanHistory = vi.fn();
vi.mock('./discovery', () => ({ discoverMachines: vi.fn().mockResolvedValue([]) }));
vi.mock('./client', () => ({
    authenticate: vi.fn().mockResolvedValue({ token: 't', expiresAt: Date.now() + 90_000 }),
    fetchHistory,
    fetchSessions: vi.fn(),
    LanRequestError: class extends Error { constructor(m: string, readonly status: number) { super(m); } },
}));
vi.mock('./history', () => ({ decryptLanHistory, decryptLanEntries: vi.fn() }));
vi.mock('@/sync/typesRaw', () => ({ normalizeRawMessage: vi.fn() }));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));

const { readSessionOverLan } = await import('./sessionChannel');

const base = {
    sessionId: 's1', machineId: 'm1', accountPublicKey: new Uint8Array(32),
    machineKey: new Uint8Array(32), encryption: {} as any, via: 'relay' as const,
};
const RELAY = 'https://1.2.3.4/r/' + 'b'.repeat(32);

const page = (entries: any[], cursor: string, more: boolean) => ({
    tag: 'x', dataEncryptionKey: '', entries, cursor, reset: false, more,
});

afterEach(() => { vi.clearAllMocks(); });

describe('readSessionOverLan paging', () => {
    it('reads pages until the daemon says the log is exhausted', async () => {
        fetchHistory
            .mockResolvedValueOnce(page([{ id: 'a' }], '0:1', true))
            .mockResolvedValueOnce(page([{ id: 'b' }], '0:2', false));
        decryptLanHistory.mockImplementation(async (_e: unknown, h: any) => ({
            entries: h.entries.map((e: any) => ({ id: e.id })),
            decryptedCount: h.entries.length,
            sessionKey: new Uint8Array(32),
        }));

        const read = await readSessionOverLan({ ...base, relayBaseUrl: RELAY });
        expect(fetchHistory).toHaveBeenCalledTimes(2);
        expect(fetchHistory.mock.calls[1][3]).toBe('0:1');
        expect(read?.total).toBe(2);
        expect(read?.cursor).toBe('0:2');
    });

    it('stops when a page does not advance the cursor, rather than looping forever', async () => {
        // `more` stays true and the cursor never moves past the first real position, so a reader
        // that trusted `more` alone would page until its ceiling.
        fetchHistory.mockResolvedValue(page([], '0:1', true));
        decryptLanHistory.mockResolvedValue({ entries: [], decryptedCount: 0, sessionKey: new Uint8Array(32) });

        const read = await readSessionOverLan({ ...base, relayBaseUrl: RELAY });
        expect(fetchHistory).toHaveBeenCalledTimes(2);
        expect(read?.cursor).toBe('0:1');
    });
});
