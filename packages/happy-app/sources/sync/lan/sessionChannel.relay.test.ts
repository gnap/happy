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
    page: { kind: 'tail' as const },
};
const RELAY = 'https://1.2.3.4/r/' + 'b'.repeat(32);
const LAN = 'http://192.168.5.87:55673';
const page = { tag: 'x', dataEncryptionKey: '', entries: [], cursor: 'c', older: 'b', hasNewer: false, hasOlder: false, reset: false };

afterEach(async () => {
    // `clearAllMocks` leaves implementations in place, and the credential is cached per address for
    // ninety seconds — either one would let a test inherit the previous test's answers.
    vi.resetAllMocks();
    const { invalidateLanCredential } = await import('./credentials');
    for (const address of [LAN, RELAY, 'http://10.99.0.1:55673', 'http://192.168.5.88:55673']) {
        invalidateLanCredential(address);
    }
});

describe('readSessionOverLan', () => {
    it('reads at an address the machine published, which the read path could not do before', async () => {
        // The reported symptom in one test: a machine found without mDNS was chosen as "on the LAN"
        // and the read had no way to try the address it published, so the channel was selected and
        // then failed — over and over. The browse is not what makes an address usable.
        authenticate.mockResolvedValue({ token: 't', expiresAt: Date.now() + 90_000 });
        fetchHistory.mockResolvedValue(page);

        const attempt = await readSessionOverLan({ ...base, candidates: [{ baseUrl: LAN, route: 'lan' }] });

        expect(discoverMachines).not.toHaveBeenCalled();
        expect(authenticate).toHaveBeenCalledWith(LAN, base.machineKey);
        expect(attempt.kind).toBe('read');
        if (attempt.kind === 'read') {
            expect(attempt.read.connection.baseUrl).toBe(LAN);
        }
    });

    it('advances to the next address when one does not answer, and says which failed', async () => {
        // A machine that lists a direct-attach port before the network it is actually on: the first
        // address costs a timeout and the second one serves the page.
        authenticate.mockImplementation(async (baseUrl: string) => {
            if (baseUrl === 'http://10.99.0.1:55673') {
                throw new Error('connect timeout');
            }
            return { token: 't', expiresAt: Date.now() + 90_000 };
        });
        fetchHistory.mockResolvedValue(page);

        const attempt = await readSessionOverLan({
            ...base,
            candidates: [{ baseUrl: 'http://10.99.0.1:55673', route: 'lan' }, { baseUrl: LAN, route: 'lan' }],
        });

        expect(attempt.kind).toBe('read');
        if (attempt.kind === 'read') {
            expect(attempt.read.connection.baseUrl).toBe(LAN);
        }
    });

    it('reports an address nothing answered at, rather than a page that never came', async () => {
        authenticate.mockRejectedValue(new Error('EHOSTUNREACH'));

        const attempt = await readSessionOverLan({ ...base, candidates: [{ baseUrl: LAN, route: 'lan' }] });

        expect(attempt).toMatchObject({ kind: 'unreachable', baseUrl: LAN });
    });

    it('a daemon with no log for this session is not an address failure', async () => {
        // What the health record must never demote an address for: the address answered.
        authenticate.mockResolvedValue({ token: 't', expiresAt: Date.now() + 90_000 });
        fetchHistory.mockResolvedValue(null);

        const attempt = await readSessionOverLan({ ...base, candidates: [{ baseUrl: LAN, route: 'lan' }] });

        expect(attempt).toEqual({ kind: 'absent', baseUrl: LAN });
    });

    it('reports a refusal as the daemon\'s answer, and does not ask other addresses', async () => {
        const { LanRequestError } = await import('./client') as any;
        authenticate.mockRejectedValue(new LanRequestError('forbidden', 403));

        const attempt = await readSessionOverLan({
            ...base,
            candidates: [{ baseUrl: LAN, route: 'lan' }, { baseUrl: 'http://192.168.5.88:55673', route: 'lan' }],
        });

        expect(attempt).toEqual({ kind: 'refused', baseUrl: LAN, status: 403 });
        expect(authenticate).toHaveBeenCalledTimes(1);
    });

    it('reuses a cached connection only while its address is still one worth trying', async () => {
        authenticate.mockResolvedValue({ token: 't2', expiresAt: Date.now() + 90_000 });
        fetchHistory.mockResolvedValue(page);
        const cached = { machineId: 'm1', route: 'lan' as const, baseUrl: LAN };

        // Still offered: the memory is used directly, and nothing browses for it.
        const kept = await readSessionOverLan({ ...base, candidates: [{ baseUrl: LAN, route: 'lan' }], connection: cached });
        expect(kept.kind).toBe('read');
        if (kept.kind === 'read') {
            expect(kept.read.connection.baseUrl).toBe(LAN);
        }
        expect(discoverMachines).not.toHaveBeenCalled();

        // Demoted and no longer offered: the memory is not used, and the relay is where the read goes.
        const moved = await readSessionOverLan({ ...base, candidates: [{ baseUrl: RELAY, route: 'relay' }], connection: cached });
        expect(moved.kind).toBe('read');
        if (moved.kind === 'read') {
            expect(moved.read.connection.route).toBe('relay');
        }
    });

    it('is an attempt at nothing when there is no address to try', async () => {
        const attempt = await readSessionOverLan({ ...base, candidates: [] });
        expect(attempt.kind).toBe('absent');
        expect(authenticate).not.toHaveBeenCalled();
    });
});
