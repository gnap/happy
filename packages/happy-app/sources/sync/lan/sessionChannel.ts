import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';
import { Encryption } from '@/sync/encryption/encryption';
import { discoverMachines } from './discovery';
import { authenticate, fetchHistory, fetchSessions, LanRequestError } from './client';
import { decryptLanEntries, decryptLanHistory, type DecryptedLanEntry } from './history';

import type { DaemonRoute, LanSessionSummary } from './types';

/**
 * How many pages one following read may take before it hands back. Each page is a round trip, and
 * a window that is many pages behind is drained over several ticks rather than in one long call
 * that the UI waits on.
 */
const MAX_FOLLOW_PAGES = 4;

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
    /** Boundary after this page's last entry: hand back as `follow` to keep up with the log. */
    cursor: string;
    /** Boundary before this page's first entry: hand back as `older` to read further back. */
    older: string;
    /**
     * The log has entries after this page, which means the page was cut short at its budget: the
     * reader is further behind than one page, and belongs at the newest one instead of walking.
     */
    hasNewer: boolean;
    /** The log has entries before this page. The UI's "load older" gate. */
    hasOlder: boolean;
    /** True when the anchor was not honoured and `messages` covers the log from its start. */
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
    /**
     * Which page to read. `tail` is the newest page — what opening a session wants; `follow`
     * continues forward from a boundary; `older` walks back from one. Every read is one bounded
     * page: a reader that pages forward until it catches up is a reader that can be minutes behind
     * on a long session, because it must carry every entry written while it was away.
     */
    page: { kind: 'tail' } | { kind: 'follow'; cursor: string } | { kind: 'older'; before: string };
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

    /**
     * Following reads in bounded pages: a page that comes back cut short means the log is further
     * ahead than one page, and the window is *extended* rather than abandoned — the messages the
     * caller already holds are the conversation the user is looking at, so catching up must add to
     * them, never replace them. `MAX_FOLLOW_PAGES` bounds one call; `hasNewer` stays on the result
     * so the caller can come back for the rest, which is what the server channel's own "still
     * behind → invalidate again" loop does.
     */
    const readFrom = async (connection: LanConnection): Promise<LanSessionRead | null> => {
        const request = (page: typeof options.page) =>
            fetchHistory(
                connection.baseUrl,
                connection.token,
                options.sessionId,
                page.kind === 'follow' ? { since: page.cursor } : page.kind === 'older' ? { before: page.before } : {},
            );
        const decode = async (history: Awaited<ReturnType<typeof fetchHistory>>) => {
            if (!history) {
                return null;
            }
            const decrypted = await decryptLanHistory(options.encryption, history);
            return {
                machineId: connection.machineId,
                tag: history.tag,
                messages: toNormalizedMessages(decrypted.entries),
                decryptedCount: decrypted.decryptedCount,
                total: decrypted.entries.length,
                cursor: history.cursor,
                older: history.older,
                hasNewer: history.hasNewer,
                hasOlder: history.hasOlder,
                reset: history.reset,
                connection,
                sessionKey: decrypted.sessionKey as Uint8Array,
            };
        };

        const first = await decode(await request(options.page));
        if (!first || options.page.kind !== 'follow' || !first.hasNewer) {
            return first;
        }

        let drained = first;
        for (let page = 1; page < MAX_FOLLOW_PAGES && drained.hasNewer; page += 1) {
            const next = await decode(await request({ kind: 'follow', cursor: drained.cursor }));
            // A page that does not move the cursor is a daemon that cannot answer the question; the
            // alternative to stopping here is a loop that never ends.
            if (!next || next.cursor === drained.cursor) {
                break;
            }
            drained = {
                ...next,
                messages: [...drained.messages, ...next.messages],
                decryptedCount: drained.decryptedCount + next.decryptedCount,
                total: drained.total + next.total,
                // The window's floor is where the *first* page started: following moves the top.
                older: drained.older,
                hasOlder: drained.hasOlder,
            };
        }
        return drained;
    };

    // The connection from the previous read is tried first, because discovery is the expensive
    // half: a browse runs for its entire timeout, so paying it on every poll would make the
    // channel slower the more often it is used.
    const cached = options.connection;
    // A cached connection is only reusable for the route it was made on: a session being read over
    // the relay must not be handed the LAN connection another session left behind, and the other
    // way round.
    const cachedMatchesRoute = options.via === 'any' || cached?.route === options.via;
    if (cached && cached.machineId === options.machineId && cachedMatchesRoute) {
        if (isConnectionUsable(cached, options.machineId)) {
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
        } else {
            // The bearer token aged out — it is 90s server-side and only counts as usable with
            // 15s left, so this happens about every 75 seconds. The *address* is still good:
            // discovery exists to find it, and we already have it, so re-ask the same host for a
            // token instead of browsing again. A browse is not returned early, it collects until
            // its timeout elapses, so rediscovering a machine we can already reach costs a flat
            // 4s — on a channel polled every 2s, that is most of what it spends its time on.
            // Only a host that has actually moved falls through to discovery below.
            try {
                const { token, expiresAt } = await authenticate(cached.baseUrl, machineKey);
                const result = await readFrom({ ...cached, token, expiresAt });
                if (result) {
                    return result;
                }
            } catch {
                // Unreachable or refused: fall through to a full browse.
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
