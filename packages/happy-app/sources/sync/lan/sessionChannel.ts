import { yieldTask } from '@/utils/yieldTask';
import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';
import { collapseDuplicateMessages } from '@/sync/messageIdentity';
import { Encryption } from '@/sync/encryption/encryption';
import { discoverMachines } from './discovery';
import { fetchHistory, fetchSessions, LanRequestError } from './client';
import { getLanCredential, invalidateLanCredential } from './credentials';
import { log } from '@/log';
import { decryptLanEntries, decryptLanHistory, type DecryptedLanEntry } from './history';

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
    /**
     * The `localId`s of entries the session *received* — its own record that a user message reached
     * it. This is the durable form of the delivery verdict, which arrives as one broadcast frame
     * that a reconnecting socket can miss entirely.
     */
    received: string[];
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
    /** Endpoint and route used, to hand back as `connection` on the next read. */
    connection: LanConnection;
    /**
     * The session key this read unwrapped, for the caller to register.
     *
     * Handed back rather than registered here on purpose: holding the key is App state, not a
     * property of the LAN, and a channel that registers it is a channel that has to remember to.
     */
    sessionKey: Uint8Array;
};

/**
 * Where a daemon can be reached, and by which route.
 *
 * Deliberately not a credential: the address outlives any token, and a token belongs to the daemon
 * rather than to whoever is reading it. `./credentials` holds the token, keyed by this address.
 */
export type LanConnection = {
    machineId: string;
    /** Which route this connection came in on: found on the network, or through the public relay. */
    route: DaemonRoute;
    baseUrl: string;
};

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
/**
 * The same projection, yielding as it goes.
 *
 * A page a read brings back can be hundreds of entries, and each one is a JSON parse plus the
 * zod transforms — all of it on the JS thread, measured as multi-second stays during which a tap
 * starved. One hop per `every` entries bounds any waiting interaction to one chunk's worth of
 * work. The live socket's single entry keeps the synchronous shape above.
 */
export async function toNormalizedMessagesChunked(entries: DecryptedLanEntry[], every = 25): Promise<NormalizedMessage[]> {
    const messages: NormalizedMessage[] = [];
    let sinceYield = 0;
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
        if (++sinceYield >= every) {
            sinceYield = 0;
            await yieldTask();
        }
    }
    return collapseDuplicateMessages(messages);
}

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
    // A log entry is a wire event, and one message can be two of them: the queued `out` entry and
    // the `in` echo the server sends back carry the same `localId` and the same ciphertext. The
    // page a reader wants is messages, so the copies are collapsed here — see
    // `collapseDuplicateMessages`. One entry at a time (the live socket) passes through unchanged.
    return collapseDuplicateMessages(messages);
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
}): Promise<{ machineId: string; via: DaemonRoute; baseUrl: string; sessions: LanSessionSummary[] }[]> {
    const answers: { machineId: string; via: DaemonRoute; baseUrl: string; sessions: LanSessionSummary[] }[] = [];
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
            const { token } = await getLanCredential(machine.baseUrl, machineKey);
            answers.push({ machineId: machine.machineId, via: 'lan', baseUrl: machine.baseUrl, sessions: await fetchSessions(machine.baseUrl, token) });
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
            const { token } = await getLanCredential(relay.baseUrl, machineKey);
            answers.push({ machineId: relay.machineId, via: 'relay', baseUrl: relay.baseUrl, sessions: await fetchSessions(relay.baseUrl, token) });
        } catch {
            // This relay route is down or its daemon is offline.
        }
    }));
    return answers;
}

/**
 * What one read found, with the address failures told apart from everything else.
 *
 * `null` used to carry all of these at once — no candidates, a daemon with no log for the session,
 * and a machine that could not be reached — so the caller recorded a route failure for whichever it
 * happened to be. A health record built on that would demote a working address because a session
 * had not been written to the log yet.
 */
export type LanAttempt =
    | { kind: 'read'; read: LanSessionRead }
    /** It answered, and has no log for this session. Nothing about the address. */
    | { kind: 'absent'; baseUrl: string }
    /** Nothing answered there: refused to connect, or timed out. */
    | { kind: 'unreachable'; baseUrl: string; error: unknown }
    /** It answered and refused this device — a bad proof, or the daemon's own error. */
    | { kind: 'refused'; baseUrl: string; status: number };

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
     * Whether the reader already holds this entry. A daemon page is bounded but whole — it can be
     * hundreds of entries when only a handful are new — and decrypting and normalising the rest
     * is the cost of a read measured in seconds. The envelope carries id/localId in the clear, so
     * known entries can be dropped before the decryptor sees them.
     */
    isKnown?: (id: string, localId: string | null) => boolean;
    /**
     * Every address worth trying, best first, already filtered to those that may be tried now.
     *
     * The caller decides this, not a browse: an address the machine published is as real as one a
     * browse found, and until this was a parameter the read could only use the latter — which is
     * why a machine found without mDNS was chosen as "on the LAN" and then could not be read there.
     * A browse still has its place, and pays for it once per scan rather than once per read.
     */
    candidates: readonly { baseUrl: string; route: 'lan' | 'relay' }[];
    /**
     * Connection from the previous read. Reused while it is still valid, which is what keeps the
     * challenge-response out of every poll.
     */
    connection?: LanConnection | null;
}): Promise<LanAttempt> {
    const machineKey = options.machineKey;
    if (!machineKey) {
        return { kind: 'absent', baseUrl: '' };
    }

    /**
     * One page, one request — and a cut-short page handed back as it is.
     *
     * A follow read that comes back cut short is the answer to a question the caller asked, not a
     * job left half-done: it says the reader is further behind than one page, and the reader that is
     * told this belongs at the newest page rather than at the end of a chain of them. Draining
     * forward instead — several pages per call, several calls per tick — is what made opening a
     * session that had been idle for a day take as long as the day was busy: every page of the
     * backlog was fetched, decrypted and applied before the newest one arrived. `hasNewer` reaches
     * the caller intact, and the caller decides.
     */
    const readFrom = async (connection: LanConnection): Promise<LanSessionRead | null> => {
        /**
         * Every request takes its token from the daemon-wide credential rather than from the
         * connection this read was handed. The connection says *where* to read; the credential is
         * whoever's token is current for that address. Keeping a token per connection is what made
         * each session's poll loop handshake on its own schedule, and made a token that had gone
         * stale mid-read fail the read instead of being replaced underneath it.
         */
        const request = async (page: typeof options.page) => {
            const query: { since: string } | { before: string } | Record<string, never> =
                page.kind === 'follow' ? { since: page.cursor } : page.kind === 'older' ? { before: page.before } : {};
            // Acquired outside the try: a rejected *proof* is a credential problem, not a token
            // problem, and treating it as one would answer a wrong machine key with a second
            // handshake it is going to fail anyway.
            const current = await getLanCredential(connection.baseUrl, machineKey);
            try {
                return await fetchHistory(connection.baseUrl, current.token, options.sessionId, query);
            } catch (error) {
                // The daemon knows nothing about this token: it was minted by a process that is
                // gone, which is what a daemon restart leaves behind. Dropping it and asking once
                // more is the whole recovery — the read is idempotent, and a page is cheap
                // compared to making the caller wait for the next tick and read it all again.
                if (!(error instanceof LanRequestError) || error.status !== 401) {
                    throw error;
                }
                invalidateLanCredential(connection.baseUrl);
                const retry = await getLanCredential(connection.baseUrl, machineKey);
                return await fetchHistory(connection.baseUrl, retry.token, options.sessionId, query);
            }
        };
        const decode = async (history: Awaited<ReturnType<typeof fetchHistory>>) => {
            if (!history) {
                return null;
            }
            const decryptStartedAt = Date.now();
            const allEntries = history.entries;
            const known = options.isKnown;
            const filtered = known
                ? allEntries.filter((entry) => !known(entry.id, entry.localId ?? null))
                : allEntries;
            // A tail page is the whole bounded page — hundreds of entries — but the window a
            // screen renders is tens. Decrypting the rest to throw it away is the seconds-long
            // tail read; the newest slice is the part the window becomes, and older history is
            // reachable by scrolling through the ordinary older-page path.
            // Any page, not just a tail: a follow read against a stale cursor is answered with the
            // whole backlog (measured: 465 entries on a session whose window holds 150), and
            // decrypting it is the seconds-long read. The window only ever becomes the newest
            // slice; the rest is reachable through the older-page path when scrolled to.
            const PAGE_DECRYPT_LIMIT = 150;
            const entries = filtered.length > PAGE_DECRYPT_LIMIT
                ? filtered.slice(-PAGE_DECRYPT_LIMIT)
                : filtered;
            const decrypted = await decryptLanHistory(options.encryption, { ...history, entries });
            const decryptMs = Date.now() - decryptStartedAt;
            return {
                machineId: connection.machineId,
                tag: history.tag,
                messages: await (async () => {
                    const normalizeStartedAt = Date.now();
                    const normalized = await toNormalizedMessagesChunked(decrypted.entries);
                    log.log(
                        `⏱️ lan read: decrypt ${decryptMs}ms normalize ${Date.now() - normalizeStartedAt}ms` +
                        ` (${decrypted.entries.length} entries)`
                    );
                    return normalized;
                })(),
                received: received(decrypted.entries),
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

        const received = (entries: DecryptedLanEntry[]): string[] =>
            entries.filter((entry) => entry.dir === 'in' && entry.localId).map((entry) => entry.localId as string);

        return decode(await request(options.page));
    };

    // The connection from the previous read is tried first, because discovery is the expensive
    // half: a browse runs for its entire timeout, so paying it on every poll would make the
    // channel slower the more often it is used.
    const cached = options.connection;
    // Reused only while the address is still one worth trying: a connection is a memory of where
    // this machine answered, and a memory of an address that has since been demoted is not.
    if (cached && options.candidates.some((candidate) => candidate.baseUrl === cached.baseUrl)) {
        try {
            const result = await readFrom(cached);
            if (result) {
                return { kind: 'read', read: result };
            }
            // The daemon answered and has no log for this session: true of every one of its
            // addresses, so there is nothing to gain from asking the rest.
        } catch (error) {
            // The address is a memory, and what it names may have moved, gone, or restarted with a
            // different port — so an address that does not answer is rediscovered rather than
            // reported. A daemon that answered and refused is a different thing, and one this App
            // cannot fix by looking around: a rejected proof or a server error belongs to the
            // caller. The token's own expiry no longer reaches here at all; `getLanCredential`
            // replaces a token before it dies and retries once after a rejection.
            if (error instanceof LanRequestError) {
                return { kind: 'refused', baseUrl: cached.baseUrl, status: error.status };
            }
            // Nothing answered there. That is a reason to try another address, not a reason to give
            // up on the machine — and it is the fact the caller records against this address.
        }
        return { kind: 'absent', baseUrl: cached.baseUrl };
    }

    let attempt: LanAttempt = { kind: 'absent', baseUrl: options.candidates[0]?.baseUrl ?? '' };
    for (const candidate of options.candidates) {
        // No handshake here: the read takes the credential for whatever address it is about to use,
        // and only a candidate that can actually be authenticated gets that far. Proving the key
        // before asking a question the daemon may answer with a 404 is a round trip per candidate.
        try {
            const result = await readFrom({ machineId: options.machineId ?? '', route: candidate.route, baseUrl: candidate.baseUrl });
            if (result) {
                return { kind: 'read', read: result };
            }
            // The daemon answered and has no log for this session. Every candidate is an address of
            // the same machine, so asking the rest would be asking the same daemon again.
            return { kind: 'absent', baseUrl: candidate.baseUrl };
        } catch (error) {
            if (error instanceof LanRequestError) {
                // It answered, with a status that is not a page: a rejected proof, a token from a
                // daemon that has restarted, or the daemon's own error. Every one of those is about
                // the *daemon*, so the next address — which reaches the same daemon — would answer
                // the same way, and asking it would cost a round trip to be told so.
                return { kind: 'refused', baseUrl: candidate.baseUrl, status: error.status };
            }
            attempt = { kind: 'unreachable', baseUrl: candidate.baseUrl, error };
        }
    }

    return attempt;
}
