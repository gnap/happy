import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';
import { Encryption } from '@/sync/encryption/encryption';
import { discoverMachines } from './discovery';
import { authenticate, fetchHistory, fetchSessions, LanRequestError } from './client';
import { decryptLanEntries, decryptLanHistory, type DecryptedLanEntry } from './history';

/** A ceiling on the paging loop, so a daemon that never advances the cursor cannot spin forever. */
const MAX_HISTORY_PAGES = 500;
import type { DaemonRoute, LanSessionSummary } from './types';

/**
 * Reads one session over the local network, producing messages in the same shape the server path
 * produces — so the two can be merged rather than living in parallel.
 *
 * This is the App's side of a channel switch. The App is a *reader*: it never writes to either
 * channel, and nothing here sends. The CLI is the writer, and it already keeps a local log of every
 * message it has seen, which is what the LAN endpoint serves.
 *
 * The live side of the channel is `./socket`: the daemon pushes each new log entry as it is
 * written, and `toNormalizedMessages` is what turns one into the same message a read would have
 * produced. A read still runs alongside it, because a socket that dropped has to be recoverable
 * without the App knowing what it missed.
 *
 * Dependencies are passed in rather than imported from `sync`/`storage`: those modules end up
 * importing this one, and reaching back into them would be a cycle.
 */
export type LanSessionRead = {
    /** The machine that served this — needed to attribute the messages and to dedup within a writer. */
    machineId: string;
    /** The CLI's session identity. Not used for addressing; the caller already has the sessionId. */
    tag: string;
    messages: NormalizedMessage[];
    /** How many log entries actually decrypted, against how many were returned. */
    decryptedCount: number;
    total: number;
    /** Opaque position to pass back as `since` on the next read of this session. */
    cursor: string;
    /** True when the cursor was not honoured and `messages` covers the whole log. */
    reset: boolean;
    /** Endpoint and token used, to hand back as `connection` on the next read. */
    connection: LanConnection;
    /**
     * The session key this read unwrapped, for the caller to register.
     *
     * Handed back rather than registered here on purpose: holding the key is App state, not a
     * property of the LAN, and a channel that registers it is a channel that has to remember to.
     */
    sessionKey: Uint8Array;
};

/** A resolved daemon endpoint plus a live bearer token for it. */
export type LanConnection = {
    machineId: string;
    /** Which route this connection came in on: found on the network, or through the public relay. */
    route: DaemonRoute;
    baseUrl: string;
    token: string;
    /** Epoch ms. */
    expiresAt: number;
};

/** Reuse a connection only while its token has real life left; expiring mid-read costs a handshake. */
const CONNECTION_EXPIRY_MARGIN_MS = 15_000;

/**
 * Whether a connection from an earlier read can still serve this one.
 *
 * A session whose machine is unknown is deliberately never cached: the read exists to probe
 * whichever daemon answers, and pinning it to the last winner would stop it finding the right one.
 */
function isConnectionUsable(connection: LanConnection, machineId: string | undefined): boolean {
    return (
        machineId !== undefined &&
        connection.machineId === machineId &&
        connection.expiresAt - Date.now() > CONNECTION_EXPIRY_MARGIN_MS
    );
}

/**
 * A record's own timestamp, falling back to when the CLI wrote it to its log.
 *
 * `at` is a *local write* time, not the message's time — after a reconnect the CLI can write a
 * burst of messages it has just fetched, so `at` compresses a long span into a few seconds. The
 * envelope's `time` is the real one, so prefer it whenever the record carries it.
 */
function recordTimestamp(content: unknown, fallback: number): number {
    if (typeof content !== 'object' || content === null) {
        return fallback;
    }
    const record = content as Record<string, unknown>;
    const inner = record.role === 'session' && typeof record.content === 'object' && record.content !== null
        ? (record.content as Record<string, unknown>)
        : record;
    const data = typeof inner.data === 'object' && inner.data !== null
        ? (inner.data as Record<string, unknown>)
        : inner;
    const time = data.time ?? record.time;
    return typeof time === 'number' && Number.isFinite(time) ? time : fallback;
}

/**
 * Turns decrypted log entries into the messages the store holds.
 *
 * Shared by the read and the live socket because both are handed the *same* entry — one straight
 * from the log, one straight from the frame the session wrote as it appended it. If the two mapped
 * differently, the same message would land twice under two shapes and dedup on `localId` would
 * have nothing to match on. Entries that do not decrypt are skipped rather than guessed at.
 */
export function toNormalizedMessages(entries: DecryptedLanEntry[]): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    for (const entry of entries) {
        if (entry.content === null) {
            continue;
        }
        const normalized = normalizeRawMessage(
            entry.id,
            entry.localId,
            recordTimestamp(entry.content, entry.at),
            entry.content
        );
        if (normalized) {
            messages.push(normalized);
        }
    }
    return messages;
}

/**
 * Discovers the daemon, authenticates, fetches the session's log and decrypts it.
 *
 * Returns `null` — rather than throwing — for every "there is nothing to read here" outcome, so a
 * caller can treat the LAN as an optional channel without wrapping the call:
 * - no `machineKey` (its record has not been fetched, so the challenge cannot be answered)
 * - the session's machine is not advertising on this network
 * - the daemon has no local history for the session yet (a 404 — retryable, see below)
 *
 * Genuine failures (a rejected proof, an unwrappable session key) still throw: those are bugs or
 * credential problems, and silently reporting "nothing here" would hide them.
 */
/**
 * Lists what the daemons on this network say they have.
 *
 * Note what this can and cannot give. The LAN summary is `{happySessionId, directory, agent,
 * startedBy, isAlive, lastHeartbeat}` — there is no `metadata`, because metadata is encrypted and
 * only ever travels inside a message payload. So this cannot render a session row on its own: it
 * is useful for confirming which sessions exist and which are alive when the server cannot say,
 * and for noticing a session the app has never seen. Anything richer has to come from the message
 * payloads themselves.
 */
export async function listSessionsOverLan(options: {
    accountPublicKey: Uint8Array;
    /**
     * The machine key for a given machineId, or null when this device does not hold one. A key
     * only answers its own machine's challenge, so the caller has to resolve it per machine rather
     * than hand over one key and hope it matches.
     */
    machineKeyFor: (machineId: string) => Uint8Array | null;
    timeoutMs?: number;
    /** Public relay routes, tried for machines discovery did not find. */
    relays?: { machineId: string; baseUrl: string }[];
    /** Browse the local network. Off when the LAN channel is switched off. */
    browseLan?: boolean;
}): Promise<{ machineId: string; via: DaemonRoute; sessions: LanSessionSummary[] }[]> {
    const answers: { machineId: string; via: DaemonRoute; sessions: LanSessionSummary[] }[] = [];
    const answered = new Set<string>();
    const discovered = options.browseLan === false
        ? []
        : await discoverMachines({
            accountPublicKey: options.accountPublicKey,
            timeoutMs: options.timeoutMs ?? 4000,
        });

    // Every reachable machine is asked, not just the first: a session list is the union of what
    // each daemon says, and which route answered is kept so the UI can show it.
    for (const machine of discovered) {
        const machineKey = options.machineKeyFor(machine.machineId);
        if (!machineKey) {
            continue;
        }
        try {
            const { token } = await authenticate(machine.baseUrl, machineKey);
            answers.push({ machineId: machine.machineId, via: 'lan', sessions: await fetchSessions(machine.baseUrl, token) });
            answered.add(machine.machineId);
        } catch {
            // This daemon refused or dropped; the relay (or another machine) may still answer.
        }
    }
    // The relay is independent of the LAN, not a fallback for a browse that found nothing: a
    // machine that is not on this network is reached here, and one already answered above is skipped.
    await Promise.all((options.relays ?? []).map(async (relay) => {
        const machineKey = options.machineKeyFor(relay.machineId);
        if (!machineKey || answered.has(relay.machineId)) {
            return;
        }
        try {
            const { token } = await authenticate(relay.baseUrl, machineKey);
            answers.push({ machineId: relay.machineId, via: 'relay', sessions: await fetchSessions(relay.baseUrl, token) });
        } catch {
            // This relay route is down or its daemon is offline.
        }
    }));
    return answers;
}

export async function readSessionOverLan(options: {
    sessionId: string;
    /** The machine the session belongs to, from `session.metadata.machineId`. */
    machineId: string | undefined;
    /** The account content public key — what the discovery filter is derived from. */
    accountPublicKey: Uint8Array;
    /** The machine key, used to answer the daemon's challenge. */
    machineKey: Uint8Array | null;
    encryption: Encryption;
    /** Cursor from the previous read of this session; omit to read the whole log. */
    since?: string;
    /**
     * Connection from the previous read. Reused while it is still valid, which is what keeps the
     * mDNS browse and the challenge-response out of every poll — a browse alone runs for its full
     * timeout, so paying it per tick makes the channel slower the more often it is used.
     */
    connection?: LanConnection | null;
    /** The public relay route to the same daemon, when the machine published one. */
    relayBaseUrl?: string;
    /**
     * Which route to read on. `lan` only browses, `relay` only uses the relay (skipping a browse
     * for a machine known to be elsewhere, which would burn its timeout every tick), and `any`
     * browses first and falls back to the relay.
     */
    via: 'lan' | 'relay' | 'any';
}): Promise<LanSessionRead | null> {
    const machineKey = options.machineKey;
    if (!machineKey) {
        return null;
    }

    /** Reads one session from one machine; null means "this machine has no log for it yet". */
    const readFrom = async (connection: LanConnection): Promise<LanSessionRead | null> => {
        const entries: DecryptedLanEntry[] = [];
        let decryptedCount = 0;
        let tag = '';
        let sessionKey: Uint8Array | null = null;
        let cursor = options.since ?? '';
        let reset = false;
        let since = options.since;

        // A long session's log does not fit in one response — the daemon bounds each page so the
        // frame stays within what the transport carries — so read pages until the daemon says the
        // log is exhausted. The cursor moves every round; a page that left it where it was would
        // repeat forever, so the loop stops there as well as at a ceiling.
        for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
            const history = await fetchHistory(
                connection.baseUrl,
                connection.token,
                options.sessionId,
                since
            );
            if (!history) {
                return null;
            }
            const decrypted = await decryptLanHistory(options.encryption, history);
            entries.push(...decrypted.entries);
            decryptedCount += decrypted.decryptedCount;
            tag = history.tag;
            sessionKey = decrypted.sessionKey;
            cursor = history.cursor;
            // `reset` describes the whole read, so it is the first page's answer that counts.
            if (page === 0) {
                reset = history.reset;
            }
            if (!history.more || history.cursor === since) {
                break;
            }
            since = history.cursor;
        }

        return {
            machineId: connection.machineId,
            tag,
            messages: toNormalizedMessages(entries),
            decryptedCount,
            total: entries.length,
            cursor,
            reset,
            connection,
            sessionKey: sessionKey as Uint8Array,
        };
    };

    // The connection from the previous read is tried first, because discovery is the expensive
    // half: a browse runs for its entire timeout, so paying it on every poll would make the
    // channel slower the more often it is used.
    const cached = options.connection;
    const cachedMatchesRoute = options.via === 'any' || cached?.route === options.via;
    if (cached && cachedMatchesRoute && isConnectionUsable(cached, options.machineId)) {
        try {
            const result = await readFrom(cached);
            if (result) {
                return result;
            }
        } catch (error) {
            // A token can expire or be revoked between reads; only that justifies a fresh
            // handshake here. Anything else is a real failure and belongs to the caller.
            if (!(error instanceof LanRequestError) || error.status !== 401) {
                throw error;
            }
        }
    }

    const discovered = options.via === 'relay'
        ? []
        : await discoverMachines({
            accountPublicKey: options.accountPublicKey,
            // A session belongs to exactly one machine, so there is nothing to learn from the others.
            // When the id is unknown, fall back to probing whatever is advertising — the daemon
            // answers 404 for sessions it does not have, which is a cheap way to find the right one.
            timeoutMs: 4000,
        });
    const candidates: { machineId: string; baseUrl: string; route: DaemonRoute }[] = (options.machineId
        ? discovered.filter((machine) => machine.machineId === options.machineId)
        : discovered
    ).map((machine) => ({ machineId: machine.machineId, baseUrl: machine.baseUrl, route: 'lan' as const }));
    if (candidates.length === 0 && options.via !== 'lan' && options.relayBaseUrl && options.machineId) {
        candidates.push({ machineId: options.machineId, baseUrl: options.relayBaseUrl, route: 'relay' });
    }

    for (const machine of candidates) {
        const { token, expiresAt } = await authenticate(machine.baseUrl, machineKey);
        const result = await readFrom({
            machineId: machine.machineId,
            route: machine.route,
            baseUrl: machine.baseUrl,
            token,
            expiresAt,
        });
        if (result) {
            return result;
        }
    }

    return null;
}
