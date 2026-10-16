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

/** The page one read returned, or null when it returned no page at all. */
const readOf = async (options: Parameters<typeof readSessionOverLan>[0]) => {
    const attempt = await readSessionOverLan(options);
    return attempt.kind === 'read' ? attempt.read : null;
};

const RELAY = 'https://1.2.3.4/r/' + 'b'.repeat(32);
const base = {
    sessionId: 's1', machineId: 'm1', accountPublicKey: new Uint8Array(32),
    machineKey: new Uint8Array(32), encryption: {} as any,
    // These cases are about which page is asked for, so they read at one address.
    candidates: [{ baseUrl: RELAY, route: 'relay' as const }],
};

const page = (over: Partial<Record<string, unknown>> = {}) => ({
    tag: 'x', dataEncryptionKey: '', entries: [], cursor: '0:10', older: '0:0',
    hasNewer: false, hasOlder: false, reset: false, ...over,
});

afterEach(() => { vi.clearAllMocks(); });

describe('readSessionOverLan pages', () => {
    it('asks for the newest page when told to, with no anchor at all', async () => {
        fetchHistory.mockResolvedValue(page({ hasOlder: true }));
        decryptLanHistory.mockResolvedValue({ entries: [{ id: 'a' }], decryptedCount: 1, sessionKey: new Uint8Array(32) });

        const read = await readOf({ ...base, page: { kind: 'tail' } });

        expect(fetchHistory.mock.calls[0][3]).toEqual({});
        expect(read?.hasOlder).toBe(true);
        expect(read?.older).toBe('0:0');
        expect(read?.total).toBe(1);
    });

    it('follows forward from the anchor it was given', async () => {
        fetchHistory.mockResolvedValue(page());
        decryptLanHistory.mockResolvedValue({ entries: [], decryptedCount: 0, sessionKey: new Uint8Array(32) });

        await readOf({ ...base, page: { kind: 'follow', cursor: '0:42' } });

        expect(fetchHistory.mock.calls[0][3]).toEqual({ since: '0:42' });
    });

    it('reads back from the anchor it was given', async () => {
        fetchHistory.mockResolvedValue(page());
        decryptLanHistory.mockResolvedValue({ entries: [], decryptedCount: 0, sessionKey: new Uint8Array(32) });

        await readOf({ ...base, page: { kind: 'older', before: '0:42' } });

        expect(fetchHistory.mock.calls[0][3]).toEqual({ before: '0:42' });
    });

    // One read is one page. A cut-short page is not a job left half-done — it answers a question the
    // caller asked ("is this reader further behind than a page?") — and walking the pages it implies
    // is what made opening a session idle for a day take as long as the day was busy.
    it('hands a cut-short follow page back as it is, without walking to the end', async () => {
        fetchHistory.mockResolvedValue(page({ hasNewer: true, cursor: '1:500', entries: [{ id: 'a' }] }));
        decryptLanHistory.mockImplementation(async (_e: unknown, h: any) => ({
            entries: h.entries,
            decryptedCount: h.entries.length,
            sessionKey: new Uint8Array(32),
        }));

        const read = await readOf({ ...base, page: { kind: 'follow', cursor: '0:42' } });

        expect(fetchHistory).toHaveBeenCalledTimes(1);
        expect(fetchHistory.mock.calls[0][3]).toEqual({ since: '0:42' });
        expect(read?.cursor).toBe('1:500');
        expect(read?.hasNewer).toBe(true);
    });
});
