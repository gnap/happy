import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';
import { Encryption } from '@/sync/encryption/encryption';
import { discoverMachines } from './discovery';
import { authenticate, fetchHistory } from './client';
import { decryptLanHistory } from './history';

/**
 * Reads one session over the local network, producing messages in the same shape the server path
 * produces — so the two can be merged rather than living in parallel.
 *
 * This is the App's side of a channel switch. The App is a *reader*: it never writes to either
 * channel, and nothing here sends. The CLI is the writer, and it already keeps a local log of every
 * message it has seen, which is what the LAN endpoint serves.
 *
 * What this is NOT: a live channel. The daemon serves a snapshot of its log; it has no way to push
 * a new message yet. So a caller gets "everything this machine recorded, as of now" and must come
 * back for more — see the roadmap's outstanding request for a live transport.
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
export async function readSessionOverLan(options: {
    sessionId: string;
    /** The machine the session belongs to, from `session.metadata.machineId`. */
    machineId: string | undefined;
    /** The account content public key — what the discovery filter is derived from. */
    accountPublicKey: Uint8Array;
    /** The machine key, used to answer the daemon's challenge. */
    machineKey: Uint8Array | null;
    encryption: Encryption;
}): Promise<LanSessionRead | null> {
    if (!options.machineKey) {
        return null;
    }

    const discovered = await discoverMachines({
        accountPublicKey: options.accountPublicKey,
        // A session belongs to exactly one machine, so there is nothing to learn from the others.
        // When the id is unknown, fall back to probing whatever is advertising — the daemon
        // answers 404 for sessions it does not have, which is a cheap way to find the right one.
        timeoutMs: 4000,
    });
    const candidates = options.machineId
        ? discovered.filter((machine) => machine.machineId === options.machineId)
        : discovered;
    if (candidates.length === 0) {
        return null;
    }

    for (const machine of candidates) {
        const { token } = await authenticate(machine.baseUrl, options.machineKey);
        const history = await fetchHistory(machine.baseUrl, token, options.sessionId);
        if (!history) {
            // 404: this machine has no log for that session. Deliberately distinguishable from an
            // auth failure so it can be retried rather than treated as permanently absent.
            continue;
        }

        const decrypted = await decryptLanHistory(options.encryption, history);
        const messages: NormalizedMessage[] = [];
        for (const entry of decrypted.entries) {
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

        return {
            machineId: machine.machineId,
            tag: history.tag,
            messages,
            decryptedCount: decrypted.decryptedCount,
            total: decrypted.entries.length,
        };
    }

    return null;
}
