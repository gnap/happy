import { afterEach, describe, expect, it, vi } from 'vitest';

const discoverMachines = vi.fn();
const authenticate = vi.fn();
const fetchSessions = vi.fn();
vi.mock('./discovery', () => ({ discoverMachines }));
vi.mock('./client', () => ({
    authenticate, fetchSessions,
    LanRequestError: class extends Error { constructor(m: string, readonly status: number) { super(m); } },
}));
vi.mock('./history', () => ({
    decryptLanHistory: async () => ({ entries: [], decryptedCount: 0, sessionKey: new Uint8Array(32) }),
    decryptLanEntries: vi.fn(),
}));
vi.mock('@/sync/typesRaw', () => ({ normalizeRawMessage: vi.fn() }));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));

const { listSessionsOverLan } = await import('./sessionChannel');

const key = new Uint8Array(32);
/** clawbox, as this App would hold it: a subnet the browse's multicast never crosses. */
const LAN = 'http://192.168.5.87:55673';
/** 3fbc, same story from the other side. */
const OTHER = 'http://192.168.6.21:55673';
/** 3fbc's wired address, the one link mDNS does work on. */
const DIRECT = 'http://10.99.0.3:55673';
const RELAY = 'https://1.2.3.4/r/' + 'b'.repeat(32);

const sessions = (ids: string[]) =>
    ids.map((happySessionId) => ({ happySessionId, directory: '/tmp', agent: 'claude', startedBy: 'g', isAlive: true }));

const roster = (extra: Partial<Parameters<typeof listSessionsOverLan>[0]> = {}) => listSessionsOverLan({
    accountPublicKey: new Uint8Array(32),
    machineKeyFor: () => key,
    // No browse by default: a network where multicast is filtered finds nothing, which is the one
    // this branch exists for — the callers that do browse see the same empty `discovered` from it.
    browseLan: false,
    ...extra,
});

afterEach(async () => {
    // `clearAllMocks` leaves implementations in place, and the credential is cached per address for
    // ninety seconds — either one would let a test inherit the previous test's answers.
    vi.resetAllMocks();
    const { invalidateLanCredential } = await import('./credentials');
    for (const address of [LAN, OTHER, DIRECT, RELAY]) {
        invalidateLanCredential(address);
    }
});

describe('listSessionsOverLan', () => {
    it('serves a machine the browse cannot see, at the address this App holds', async () => {
        // The reported shape of an office network: the browse runs its full window and returns
        // nothing — multicast is filtered, across subnets always — while this App holds a socket at
        // the machine's published address. A roster asked there is a LAN answer, with everything
        // that means to the caller: `via: 'lan'`, and no dependency on discovery at all.
        discoverMachines.mockResolvedValue([]);
        authenticate.mockResolvedValue({ token: 't', expiresAt: Date.now() + 90_000 });
        fetchSessions.mockResolvedValue(sessions(['a']));

        const answers = await roster({ browseLan: true, lanAddresses: [{ machineId: 'm1', baseUrls: [LAN] }] });

        expect(answers).toEqual([{ machineId: 'm1', via: 'lan', baseUrl: LAN, sessions: sessions(['a']) }]);
    });

    it('tries the machine\'s next address when one has gone silent', async () => {
        // A socket this App held says where the machine answered *last*: the address can have
        // moved, or the machine can have changed networks. One failed attempt, then the next
        // address — the machine, not the address, is what the roster wants.
        authenticate.mockImplementation(async (baseUrl: string) => {
            if (baseUrl === LAN) {
                throw new Error('connect timeout');
            }
            return { token: 't', expiresAt: Date.now() + 90_000 };
        });
        fetchSessions.mockResolvedValue(sessions(['a']));

        const answers = await roster({ lanAddresses: [{ machineId: 'm1', baseUrls: [LAN, OTHER] }] });

        expect(answers.map((answer) => answer.baseUrl)).toEqual([OTHER]);
    });

    it('falls to the relay when no held address answers', async () => {
        // The held address is not a promise the machine is there — it is where it answered last.
        // Nothing answered, so this is exactly the case the relay exists for, and the machine's
        // answer arrives marked `via: 'relay'` rather than dressed up as a LAN one.
        authenticate.mockImplementation(async (baseUrl: string) => {
            if (baseUrl === LAN) {
                throw new Error('EHOSTUNREACH');
            }
            return { token: 't', expiresAt: Date.now() + 90_000 };
        });
        fetchSessions.mockResolvedValue(sessions(['b']));

        const answers = await roster({
            lanAddresses: [{ machineId: 'm1', baseUrls: [LAN] }],
            relays: [{ machineId: 'm1', baseUrl: RELAY }],
        });

        expect(answers).toEqual([{ machineId: 'm1', via: 'relay', baseUrl: RELAY, sessions: sessions(['b']) }]);
    });

    it('records silence against the address, and never a refusal', async () => {
        // The rule the address health is built on, held here too: only "nothing answered" counts
        // against an address. A daemon that answered and refused said something about this device,
        // and demoting the address for it would throw away one that works.
        const recorder = { succeeded: vi.fn(), failed: vi.fn() };
        const { LanRequestError } = await import('./client') as any;
        authenticate.mockImplementation(async (baseUrl: string) => {
            if (baseUrl === OTHER) {
                throw new LanRequestError('forbidden', 403);
            }
            if (baseUrl === LAN) {
                throw new Error('connect timeout');
            }
            return { token: 't', expiresAt: Date.now() + 90_000 };
        });
        fetchSessions.mockResolvedValue(sessions(['a']));

        const answers = await roster({
            lanAddresses: [
                { machineId: 'm1', baseUrls: [OTHER, LAN] },
                { machineId: 'm2', baseUrls: [DIRECT] },
            ],
            relays: [{ machineId: 'm1', baseUrl: RELAY }],
            recorder,
        });

        expect(recorder.failed).not.toHaveBeenCalledWith('m1', 'lan', OTHER);
        expect(recorder.failed).toHaveBeenCalledWith('m1', 'lan', LAN);
        expect(recorder.succeeded).toHaveBeenCalledWith('m2', 'lan', DIRECT);
        expect(answers.map((answer) => [answer.machineId, answer.via])).toEqual([['m2', 'lan'], ['m1', 'relay']]);
    });

    it('does not ask again at a held address for a machine the browse already answered', async () => {
        // The held addresses are for the machines the browse missed — asking an answered machine
        // again would be a second roster from the same daemon, paid in a round trip.
        discoverMachines.mockResolvedValue([
            { machineId: 'm1', host: 'spark.local', port: 55673, baseUrl: OTHER, at: Date.now() },
        ]);
        authenticate.mockResolvedValue({ token: 't', expiresAt: Date.now() + 90_000 });
        fetchSessions.mockResolvedValue(sessions(['a']));

        const answers = await roster({
            browseLan: true,
            lanAddresses: [{ machineId: 'm1', baseUrls: [LAN] }],
        });

        expect(authenticate).toHaveBeenCalledTimes(1);
        expect(authenticate).toHaveBeenCalledWith(OTHER, key);
        expect(answers.map((answer) => answer.baseUrl)).toEqual([OTHER]);
    });

    it('asks nothing for a machine whose key this device does not hold', async () => {
        const answers = await roster({
            machineKeyFor: () => null,
            lanAddresses: [{ machineId: 'm1', baseUrls: [LAN] }],
        });

        expect(authenticate).not.toHaveBeenCalled();
        expect(answers).toEqual([]);
    });
});
