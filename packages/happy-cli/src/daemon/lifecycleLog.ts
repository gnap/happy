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
 *
 * The log also carries the **desired** state, not only what happened: `lifecycle` says whether this
 * machine wants the session running or archived, and `generation` numbers successive wants. This is
 * the machine's own spec — the server is one of its channels, never the place that decides it.
 *
 * The spec rides on the existing `created` / `deleted` ops as additive fields rather than an `op:
 * 'spec'` of its own. That is a compatibility requirement, not a shortcut: an older daemon reading
 * this file stops at an op it does not know (a torn line is the only thing it can assume a bad line
 * is), which would hide every entry after the first spec. Old readers already accept `created` and
 * `deleted` and ignore fields they do not use, so a spec stated this way is replayed by every
 * version. A deletion is therefore one line that is both the desired state and its effect — the
 * append is still the transaction, and there is no window in which one is true and the other is not.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LanEndpoint } from './lanEndpoints';

export type LifecycleOp = 'created' | 'deleted' | 'reachable';

/** What this machine wants a session to be. Absent on entries written before the spec existed. */
export type LifecycleDesiredState = 'running' | 'archived';

/** A session this machine started, or wants running. */
export type LifecycleCreatedEntry = {
    /** Position in the log, 1-based and monotonic. A reader's cursor is the last entry it applied. */
    rev: number;
    at: number;
    op: 'created';
    /** The CLI's own name for the session, which exists before the server has issued anything. */
    tag: string;
    /**
     * The lineage's public name for the tag.
     *
     * Additive: readers key entries by the tag or the session id and ignore this, but a reader
     * that keeps a deletion of its own can record it against the lineage instead of one server id.
     * Absent on entries written before the uid existed, and for a spawn whose process has not
     * minted one yet.
     */
    sessionUid?: string;
    /** The server's session id, once there is one. */
    sessionId?: string;
    directory?: string;
    agent?: string;
    /**
     * The desired lifecycle this entry states.
     *
     * Optional because entries written before the spec existed say nothing about it; a `created`
     * entry is a statement that the session should run either way, so a reader that finds it absent
     * reads `running`. A later statement for the same session — a restart, for instance — repeats
     * this op with a new generation rather than inventing a second way to say it.
     */
    lifecycle?: 'running';
    /**
     * Which successive want this is, starting at 0 for the creation.
     *
     * A reader compares it with the generation the machine has observed: `observed < desired` means
     * the want has not been realized yet. Absent on entries written before the spec existed.
     */
    generation?: number;
};

/**
 * A session this machine was asked to remove.
 *
 * Either name is enough. The tag is what this machine and older readers know the session by; the
 * session id is what the server addresses. A deletion for an id this machine never held is still a
 * fact — it is how the App's delete reaches the server when the local catalog has lost the row —
 * so the entry may carry the id alone.
 *
 * The same line is also the desired state that produced it: `lifecycle: 'archived'` with the
 * generation of that want. The append is the transaction, so there is no moment at which the
 * deletion has happened but the spec still says the session should run.
 */
export type LifecycleDeletedEntry = {
    rev: number;
    at: number;
    op: 'deleted';
    tag?: string;
    /** The lineage's public name, when the tag that produced this deletion is known. */
    sessionUid?: string;
    sessionId?: string;
    directory?: string;
    agent?: string;
    lifecycle?: 'archived';
    generation?: number;
};

export type LifecycleSessionEntry = LifecycleCreatedEntry | LifecycleDeletedEntry;

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

/**
 * What `record` accepts.
 *
 * A creation has to name its tag — that is the only name it has before the server answers. A
 * deletion may name either the tag or the session id (or both); the id-only form is what lets an
 * App delete a session this machine's snapshot no longer holds.
 */
export type LifecycleFactInput =
    | { op: 'created'; tag: string; sessionUid?: string; sessionId?: string; directory?: string; agent?: string; lifecycle?: 'running'; generation?: number; at?: number }
    | { op: 'deleted'; tag: string; sessionUid?: string; sessionId?: string; directory?: string; agent?: string; lifecycle?: 'archived'; generation?: number; at?: number }
    | { op: 'deleted'; tag?: string; sessionUid?: string; sessionId: string; directory?: string; agent?: string; lifecycle?: 'archived'; generation?: number; at?: number };

const asEntry = (line: string): LifecycleEntry | null => {
    try {
        const parsed = JSON.parse(line) as {
            rev?: unknown; at?: unknown; op?: unknown; tag?: unknown; sessionId?: unknown;
            endpoints?: unknown; lifecycle?: unknown; generation?: unknown;
        };
        if (typeof parsed.rev !== 'number' || typeof parsed.at !== 'number') {
            return null;
        }
        if (parsed.op === 'reachable') {
            return Array.isArray(parsed.endpoints) ? (parsed as LifecycleReachableEntry) : null;
        }
        if (parsed.generation !== undefined && typeof parsed.generation !== 'number') {
            return null;
        }
        if (parsed.op === 'created') {
            // A lifecycle that contradicts the op is not a line this version wrote: `created` is
            // this machine saying it wants the session, so it can only ever say `running`.
            if (parsed.lifecycle !== undefined && parsed.lifecycle !== 'running') {
                return null;
            }
            return typeof parsed.tag === 'string' ? (parsed as LifecycleCreatedEntry) : null;
        }
        if (parsed.op === 'deleted') {
            if (parsed.lifecycle !== undefined && parsed.lifecycle !== 'archived') {
                return null;
            }
            // One name is enough: a deletion learned from an id alone is still addressable.
            return typeof parsed.tag === 'string' || typeof parsed.sessionId === 'string'
                ? (parsed as LifecycleDeletedEntry)
                : null;
        }
        return null;
    } catch {
        return null;
    }
};

/** The desired state a session is in after replaying the log, and the generation that states it. */
export type LifecycleSpec = {
    lifecycle: LifecycleDesiredState;
    generation: number;
    at: number;
    tag?: string;
    sessionId?: string;
};

/**
 * The newest desired state of every session the log names.
 *
 * Keyed by the tag when the lineage has one, because that is the name this machine has from the
 * moment it schedules a session and the one a later statement repeats. An entry known only by the
 * server id — a deletion for a row this machine no longer holds — is keyed by that id when no
 * entry ever paired it with a tag.
 *
 * Pairing first, folding second, is what makes an id-only statement land on the same session as
 * the tag-keyed ones. A deletion recorded from the server's name alone and the creation that
 * carried both names are one lineage; folding them separately would leave a `running` spec beside
 * the `archived` one and leave a reconciler choosing between them.
 *
 * Entries written before the spec existed carry neither field; they are read as what they meant:
 * a `created` entry wants the session running, a `deleted` entry wants it archived, generation 0.
 * That is what lets a log from an older machine fold into the same picture.
 */
export function foldLifecycleSpecs(entries: readonly LifecycleEntry[]): Map<string, LifecycleSpec> {
    // Either name is enough to identify a session, and both are present on almost every entry.
    // The maps are built first so an id-only entry can still be folded under its tag — and a
    // tag-only one under its id.
    const tagBySessionId = new Map<string, string>();
    const sessionIdByTag = new Map<string, string>();
    for (const entry of entries) {
        if (entry.op !== 'created' && entry.op !== 'deleted') {
            continue;
        }
        if (entry.tag !== undefined && entry.sessionId !== undefined) {
            if (!tagBySessionId.has(entry.sessionId)) {
                tagBySessionId.set(entry.sessionId, entry.tag);
            }
            if (!sessionIdByTag.has(entry.tag)) {
                sessionIdByTag.set(entry.tag, entry.sessionId);
            }
        }
    }

    const specs = new Map<string, LifecycleSpec>();
    for (const entry of entries) {
        if (entry.op !== 'created' && entry.op !== 'deleted') {
            continue;
        }
        const tag = entry.tag ?? (entry.sessionId !== undefined ? tagBySessionId.get(entry.sessionId) : undefined);
        const sessionId = entry.sessionId ?? (tag !== undefined ? sessionIdByTag.get(tag) : undefined);
        const key = tag ?? sessionId;
        if (key === undefined) {
            continue;
        }
        specs.set(key, {
            lifecycle: entry.lifecycle ?? (entry.op === 'created' ? 'running' : 'archived'),
            generation: entry.generation ?? 0,
            at: entry.at,
            ...(tag !== undefined ? { tag } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
        });
    }
    return specs;
}

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
    record(entry: LifecycleFactInput): LifecycleSessionEntry {
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
