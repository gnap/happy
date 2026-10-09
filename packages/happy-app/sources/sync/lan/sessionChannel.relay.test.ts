import { afterEach, describe, expect, it, vi } from 'vitest';

const discoverMachines = vi.fn();
const authenticate = vi.fn();
const fetchHistory = vi.fn();
vi.mock('./discovery', () => ({ discoverMachines }));
vi.mock('./client', () => ({
    authenticate, fetchHistory, fetchSessions: vi.fn(),
    LanRequestError: class extends Error { constructor(m: string, readonly status: number) { super(m); } },
}));
vi.mock('./history', () => ({
    decryptLanHistory: async () => ({ entries: [], decryptedCount: 0, sessionKey: new Uint8Array(32) }),
    decryptLanEntries: vi.fn(),
}));
vi.mock('@/sync/typesRaw', () => ({ normalizeRawMessage: vi.fn() }));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));

const { readSessionOverLan } = await import('./sessionChannel');

const base = {
    sessionId: 's1', machineId: 'm1', accountPublicKey: new Uint8Array(32),
    machineKey: new Uint8Array(32), encryption: {} as any,
};
const RELAY = 'https://1.2.3.4/r/' + 'b'.repeat(32);

afterEach(() => { vi.clearAllMocks(); });

describe('readSessionOverLan relay', () => {
    it('falls back to the relay when discovery finds nothing', async () => {
        discoverMachines.mockResolvedValue([]);
        authenticate.mockResolvedValue({ token: 't', expiresAt: Date.now() + 90_000 });
        fetchHistory.mockResolvedValue({ tag: 'x', dataEncryptionKey: '', entries: [], cursor: 'c', reset: false });
        const read = await readSessionOverLan({ ...base, relayBaseUrl: RELAY, via: 'any' });
        expect(authenticate).toHaveBeenCalledWith(RELAY, base.machineKey);
        expect(read?.connection.baseUrl).toBe(RELAY);
        expect(read?.connection.route).toBe('relay');
    });

    it('skips the browse entirely when the session is on the relay', async () => {
        authenticate.mockResolvedValue({ token: 't', expiresAt: Date.now() + 90_000 });
        fetchHistory.mockResolvedValue({ tag: 'x', dataEncryptionKey: '', entries: [], cursor: 'c', reset: false });
        await readSessionOverLan({ ...base, relayBaseUrl: RELAY, via: 'relay' });
        expect(discoverMachines).not.toHaveBeenCalled();
    });

    it('never uses the relay when pinned to the LAN', async () => {
        discoverMachines.mockResolvedValue([]);
        const read = await readSessionOverLan({ ...base, relayBaseUrl: RELAY, via: 'lan' });
        expect(read).toBeNull();
        expect(authenticate).not.toHaveBeenCalled();
    });

    it('does not reuse a LAN connection when the session is on the relay', async () => {
        authenticate.mockResolvedValue({ token: 't2', expiresAt: Date.now() + 90_000 });
        fetchHistory.mockResolvedValue({ tag: 'x', dataEncryptionKey: '', entries: [], cursor: 'c', reset: false });
        const lan = { machineId: 'm1', route: 'lan' as const, baseUrl: 'http://10.0.0.2:55673', token: 't', expiresAt: Date.now() + 90_000 };
        const read = await readSessionOverLan({ ...base, relayBaseUrl: RELAY, via: 'relay', connection: lan });
        expect(read?.connection.route).toBe('relay');
    });

    it('prefers a discovered LAN daemon over the relay', async () => {
        discoverMachines.mockResolvedValue([{ machineId: 'm1', baseUrl: 'http://10.0.0.2:55673' }]);
        authenticate.mockResolvedValue({ token: 't', expiresAt: Date.now() + 90_000 });
        fetchHistory.mockResolvedValue({ tag: 'x', dataEncryptionKey: '', entries: [], cursor: 'c', reset: false });
        const read = await readSessionOverLan({ ...base, relayBaseUrl: RELAY, via: 'any' });
        expect(read?.connection.baseUrl).toBe('http://10.0.0.2:55673');
        expect(read?.connection.route).toBe('lan');
    });
});
