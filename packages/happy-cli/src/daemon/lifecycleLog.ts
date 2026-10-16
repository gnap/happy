/**
 * Durable log of session lifecycle: which sessions this machine has started, and which it has
 * archived.
 *
 * The daemon's state was a *snapshot* — a mapping of sessions, rewritten wholesale — and a snapshot
 * has to be self-consistent at every instant, which in practice means the server has to have agreed
 * before the App can be told anything. This is the same move the message log made: keep the *fact*,
 * in order, on disk, and let every reader replay it at its own pace. The App can then show a
 * session the moment this machine has one, and the server catching up is a separate progress.
 *
 * Append-only JSONL, and deliberately **not** rotated by age or size the way the message log is: an
 * entry here is not a historical record to be pruned, it is a state fact. Dropping a `deleted` line
 * by age would resurrect the session. Sessions are created and archived rarely enough that the file
 * stays small for years, so "this is permanent" is the honest encoding.
 *
 * Identity is the **tag** the CLI owns, not the server's session id: a session has a tag from the
 * moment it is spawned and an id only once the server has answered, and that stretch is the whole
 * reason this exists. The id is recorded beside it when it arrives.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LifecycleOp = 'created' | 'deleted';

export type LifecycleEntry = {
    /** Position in the log, 1-based and monotonic. A reader's cursor is the last entry it applied. */
    rev: number;
    at: number;
    op: LifecycleOp;
    /** The CLI's own name for the session, which exists before the server has issued anything. */
    tag: string;
    /** The server's session id, once there is one. */
    sessionId?: string;
    directory?: string;
    agent?: string;
};

const asEntry = (line: string): LifecycleEntry | null => {
    try {
        const parsed = JSON.parse(line) as Partial<LifecycleEntry>;
        if (typeof parsed.rev !== 'number' || typeof parsed.tag !== 'string' || (parsed.op !== 'created' && parsed.op !== 'deleted')) {
            return null;
        }
        return parsed as LifecycleEntry;
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
     * Appends one fact, and returns it as it was written.
     *
     * Written before anything else happens — before a session is spawned, before it is archived —
     * because the log is what other parties replay: a fact this machine acted on but did not write
     * is a fact nobody else can be told.
     */
    record(entry: { op: LifecycleOp; tag: string; sessionId?: string; directory?: string; agent?: string; at?: number }): LifecycleEntry {
        const written: LifecycleEntry = { ...entry, rev: this.revision() + 1, at: entry.at ?? Date.now() };
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, `${JSON.stringify(written)}\n`, 'utf8');
        return written;
    }
}
