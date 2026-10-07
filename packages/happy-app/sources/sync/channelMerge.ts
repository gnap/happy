import { compareByIdentity, type WriterIdentity } from './writerIdentity';

/**
 * Merges what two channels say about the same session into one list.
 *
 * The App is a reader: it does not write to either channel, and nothing here sends anything. The
 * whole job is to make "the same session, fetched twice by different routes" look like one list —
 * no duplicates, a stable order, and a trustworthy signal when something is actually missing.
 *
 * Both routes carry the same ciphertext, so the same message legitimately arrives twice. Which
 * key proves they are the same message depends on what the record has:
 *
 * - `localId` first, and ideally alone. The server echoes it back on both the HTTP and websocket
 *   paths, and the CLI's local log carries it too, so it is the one key that is genuinely stable
 *   across paths. (The CLI's review pushed back, correctly, on backfilling the server id into the
 *   log: the log is append-only, and `localId` already answers this.)
 * - `(site, n)` next — the writer's own counter, which is what makes the merge independent of the
 *   server's `seq` at all.
 * - the raw id last, for records written before either of the above existed.
 *
 * A message is claimed if *any* of its keys was already claimed, and claiming it claims all of
 * them — so a record that matches on `localId` also blocks its `(site, n)` twin, and vice versa.
 */

/** A message plus the keys needed to merge it. `T` is the caller's own message type. */
export type ChannelMessage<T> = {
    item: T;
    /** Server-assigned message id. */
    id: string;
    /** Client-generated id, echoed by the server on both paths. */
    localId?: string | null;
    createdAt: number;
    /** From `parseWriterIdentity` — null on records written before the CLI stamped them. */
    identity: WriterIdentity | null;
};

/** Every key a message can be recognised by, most authoritative first. */
function dedupKeys(message: ChannelMessage<unknown>): string[] {
    const keys: string[] = [];
    if (message.localId) {
        keys.push(`local:${message.localId}`);
    }
    const { site, n } = message.identity ?? {};
    if (site !== undefined && n !== undefined) {
        keys.push(`writer:${site}:${n}`);
    }
    keys.push(`id:${message.id}`);
    return keys;
}

/**
 * Order two merged messages.
 *
 * `createdAt` is the primary key because it is the only field both routes always carry and agree
 * on. `(n, site)` breaks ties inside one writer, where it is authoritative and server-independent.
 * It is deliberately NOT used as the primary: counters from different writers are independent, so
 * ordering across them by `n` would interleave two writers' messages by nothing but coincidence.
 */
function compareMessages(a: ChannelMessage<unknown>, b: ChannelMessage<unknown>): number {
    const byIdentity = compareByIdentity(a.identity, b.identity);
    if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
    }
    return byIdentity ?? 0;
}

/**
 * Deduplicates and orders the union of the server's view and the LAN's view.
 *
 * `server` is listed first and wins any conflict — not because it is more correct on the wire
 * (both carry identical ciphertext) but because it is the copy the rest of the app already keys
 * on, so preferring it keeps ids stable across a channel switch.
 */
export function mergeChannels<T>(
    server: ChannelMessage<T>[],
    lan: ChannelMessage<T>[]
): ChannelMessage<T>[] {
    const claimed = new Set<string>();
    const merged: ChannelMessage<T>[] = [];

    for (const message of [...server, ...lan]) {
        const keys = dedupKeys(message);
        if (keys.some((key) => claimed.has(key))) {
            continue;
        }
        for (const key of keys) {
            claimed.add(key);
        }
        merged.push(message);
    }

    return merged.sort(compareMessages);
}
