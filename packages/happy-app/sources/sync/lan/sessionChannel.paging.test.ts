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

const page = (over: Partial<Record<string, unknown>> = {}) => ({
    tag: 'x', dataEncryptionKey: '', entries: [], cursor: '0:10', older: '0:0',
    hasNewer: false, hasOlder: false, reset: false, ...over,
});

afterEach(() => { vi.clearAllMocks(); });

describe('readSessionOverLan pages', () => {
    it('asks for the newest page when told to, with no anchor at all', async () => {
        fetchHistory.mockResolvedValue(page({ hasOlder: true }));
        decryptLanHistory.mockResolvedValue({ entries: [{ id: 'a' }], decryptedCount: 1, sessionKey: new Uint8Array(32) });

        const read = await readSessionOverLan({ ...base, relayBaseUrl: RELAY, page: { kind: 'tail' } });

        expect(fetchHistory.mock.calls[0][3]).toEqual({});
        expect(read?.hasOlder).toBe(true);
        expect(read?.older).toBe('0:0');
        expect(read?.total).toBe(1);
    });

    it('follows forward from the anchor it was given', async () => {
        fetchHistory.mockResolvedValue(page());
        decryptLanHistory.mockResolvedValue({ entries: [], decryptedCount: 0, sessionKey: new Uint8Array(32) });

        await readSessionOverLan({ ...base, relayBaseUrl: RELAY, page: { kind: 'follow', cursor: '0:42' } });

        expect(fetchHistory.mock.calls[0][3]).toEqual({ since: '0:42' });
    });

    it('reads back from the anchor it was given', async () => {
        fetchHistory.mockResolvedValue(page());
        decryptLanHistory.mockResolvedValue({ entries: [], decryptedCount: 0, sessionKey: new Uint8Array(32) });

        await readSessionOverLan({ ...base, relayBaseUrl: RELAY, page: { kind: 'older', before: '0:42' } });

        expect(fetchHistory.mock.calls[0][3]).toEqual({ before: '0:42' });
    });

    // The window is the conversation the user is looking at, so catching up adds to it. What is
    // not acceptable is either jumping (which throws the window away) or one unbounded call (which
    // the UI waits on): both ends are bounded, and the caller is told when there is more.
    it('extends the window in bounded pages when a follow page comes back cut short', async () => {
        fetchHistory
            .mockResolvedValueOnce(page({ hasNewer: true, cursor: '1:500', entries: [{ id: 'a' }] }))
            .mockResolvedValueOnce(page({ hasNewer: false, cursor: '1:900', entries: [{ id: 'b' }] }));
        decryptLanHistory.mockImplementation(async (_e: unknown, h: any) => ({
            entries: h.entries,
            decryptedCount: h.entries.length,
            sessionKey: new Uint8Array(32),
        }));

        const read = await readSessionOverLan({ ...base, relayBaseUrl: RELAY, page: { kind: 'follow', cursor: '0:42' } });

        expect(fetchHistory.mock.calls[0][3]).toEqual({ since: '0:42' });
        expect(fetchHistory.mock.calls[1][3]).toEqual({ since: '1:500' });
        expect(read?.total).toBe(2);
        expect(read?.cursor).toBe('1:900');
        expect(read?.hasNewer).toBe(false);
    });

    it('stops at the page cap and reports that it is still behind', async () => {
        // Four pages per call, then the caller comes back: a backlog is drained over several ticks
        // rather than in one call nothing can interrupt.
        let cursor = 0;
        fetchHistory.mockImplementation(async () => page({ hasNewer: true, cursor: `1:${++cursor}`, entries: [{ id: `x${cursor}` }] }));
        decryptLanHistory.mockImplementation(async (_e: unknown, h: any) => ({
            entries: h.entries,
            decryptedCount: h.entries.length,
            sessionKey: new Uint8Array(32),
        }));

        const read = await readSessionOverLan({ ...base, relayBaseUrl: RELAY, page: { kind: 'follow', cursor: '0:0' } });

        expect(fetchHistory).toHaveBeenCalledTimes(4);
        expect(read?.hasNewer).toBe(true);
    });
});
