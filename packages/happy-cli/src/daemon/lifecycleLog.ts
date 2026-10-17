/**
 * Durable log of the facts this machine knows about itself: which sessions it has started and
 * archived, and where it can be reached.
 *
 * The daemon's state was a *snapshot* — a mapping of sessions, rewritten wholesale — and a snapshot
 * has to be self-consistent at every instant, which in practice means the server has to have agreed
 * before the App can be told anything. This is the same move the message log made: keep the *fact*,
 * in order, on disk, and let every reader replay it at its own pace. The App can then show a
 * session the moment this machine has one, and the server catching up is a separate progress.
 *
 * Append-only JSONL, and deliberately **not** rotated by age or size the way the message log is: an
 * entry here is not a historical record to be pruned, it is a state fact. Dropping a `deleted` line
 * by age would resurrect the session. Facts about a machine's own state change rarely enough that
 * the file stays small for years, so "this is permanent" is the honest encoding.
 *
 * Session identity is the **tag** the CLI owns, not the server's session id: a session has a tag
 * from the moment it is spawned and an id only once the server has answered, and that stretch is the
 * whole reason this exists. The id is recorded beside it when it arrives.
 *
 * Where the machine can be reached lives here too, and that is the point of the `reachable` op. It
 * used to be published straight to the server, which meant the address was written only while the
 * server connection was up — the one situation where a client has no other way to learn it. As an
 * entry it costs one local append, and every channel carries it: the LAN reader asks for it, the
 * server and the relay each get it replayed to them at their own pace.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LanEndpoint } from './lanEndpoints';

export type LifecycleOp = 'created' | 'deleted' | 'reachable';

/** A session this machine started, or archived. */
export type LifecycleSessionEntry = {
    /** Position in the log, 1-based and monotonic. A reader's cursor is the last entry it applied. */
    rev: number;
    at: number;
    op: 'created' | 'deleted';
    /** The CLI's own name for the session, which exists before the server has issued anything. */
    tag: string;
    /** The server's session id, once there is one. */
    sessionId?: string;
    directory?: string;
    agent?: string;
};

/**
 * Where this machine could be reached, as of `at`.
 *
 * A set, not a delta: a reader that applies the newest entry has the whole truth, so an entry missed
 * by a channel that was down is not a gap — the next one supersedes it. The addresses themselves are
 * computed elsewhere (`computeEndpoints`) with the deny-list that keeps a VPN or bridge address out
 * of anything durable.
 */
export type LifecycleReachableEntry = {
    rev: number;
    at: number;
    op: 'reachable';
    endpoints: LanEndpoint[];
};

export type LifecycleEntry = LifecycleSessionEntry | LifecycleReachableEntry;

const asEntry = (line: string): LifecycleEntry | null => {
    try {
        const parsed = JSON.parse(line) as { rev?: unknown; at?: unknown; op?: unknown; tag?: unknown; endpoints?: unknown };
        if (typeof parsed.rev !== 'number' || typeof parsed.at !== 'number') {
            return null;
        }
        if (parsed.op === 'reachable') {
            return Array.isArray(parsed.endpoints) ? (parsed as LifecycleReachableEntry) : null;
        }
        if (parsed.op !== 'created' && parsed.op !== 'deleted') {
            return null;
        }
        return typeof parsed.tag === 'string' ? (parsed as LifecycleSessionEntry) : null;
    } catch {
        return null;
    }
};

export class LifecycleLog {
    constructor(private readonly file: string) {}

    /**
     * Every entry, oldest first.
     *
     * A line that does not parse is dropped rather than failing the read, and the read stops there
     * rather than skipping it: the only way this file grows is an append, so a bad line is a torn
     * tail from a crash, and everything after it is nothing at all. Skipping it would silently
     * reorder the entries that followed.
     */
    read(): LifecycleEntry[] {
        if (!existsSync(this.file)) {
            return [];
        }
        const entries: LifecycleEntry[] = [];
        for (const line of readFileSync(this.file, 'utf8').split('\n')) {
            if (line.trim().length === 0) {
                continue;
            }
            const entry = asEntry(line);
            if (entry === null) {
                break;
            }
            entries.push(entry);
        }
        return entries;
    }

    /** Where a reader stands after applying everything — the cursor it sends back next time. */
    revision(): number {
        const entries = this.read();
        return entries.length === 0 ? 0 : entries[entries.length - 1].rev;
    }

    /** What a reader that has applied up to `since` has not seen. */
    entriesSince(since: number): LifecycleEntry[] {
        return this.read().filter((entry) => entry.rev > since);
    }

    /**
     * The newest address entry, or null if this machine has never recorded one.
     *
     * For the readers that only want the current answer rather than the walk: a channel that keeps a
     * live connection to the relay publishes the set as it stands, and the entry it came from is the
     * one a client applies to get the same answer.
     */
    latestReachable(): LifecycleReachableEntry | null {
        const entries = this.read();
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].op === 'reachable') {
                return entries[i] as LifecycleReachableEntry;
            }
        }
        return null;
    }

    /**
     * Appends one fact, and returns it as it was written.
     *
     * Written before anything else happens — before a session is spawned, before it is archived —
     * because the log is what other parties replay: a fact this machine acted on but did not write
     * is a fact nobody else can be told.
     */
    record(entry: { op: 'created' | 'deleted'; tag: string; sessionId?: string; directory?: string; agent?: string; at?: number }): LifecycleSessionEntry {
        return this.append({ ...entry, at: entry.at ?? Date.now() });
    }

    /**
     * Records where this machine can be reached, when that has changed.
     *
     * Local, and that is the whole reason it is here: the append cannot fail for the network being
     * down, so the address exists whether or not the server is there to hear it.
     */
    recordReachable(endpoints: readonly LanEndpoint[], at?: number): LifecycleReachableEntry {
        return this.append({ op: 'reachable', endpoints: [...endpoints], at: at ?? Date.now() });
    }

    private append<T extends { at: number }>(entry: T): T & { rev: number } {
        const written = { ...entry, rev: this.revision() + 1 };
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, `${JSON.stringify(written)}\n`, 'utf8');
        return written;
    }
}
