/**
 * The log is the CLI's only copy of what a session said, so these tests focus on the ways a
 * file-backed append log goes wrong: a torn tail, rotation, and an unwritable directory.
 * Real filesystem; only `@/configuration` is mocked (temp happy home).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ happyHome: '/tmp/happy-test-home' }));

vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir() {
            return state.happyHome;
        },
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

import { appendSessionLog, readSessionLog, readSessionLogSince, sessionLogDir, pruneSessionLogs, type SessionLogEntry } from './sessionLog';

let home: string;
/** Distinct tag per test: the torn-tail check is memoised per path within a process. */
const tagFor = (name: string) => `tag-${name}`;
const SITE = 'machine-1';

const entry = (n: number, dir: 'in' | 'out' = 'out'): SessionLogEntry => ({
    id: `id-${n}`,
    localId: `local-${n}`,
    dir,
    at: 1_700_000_000_000 + n,
    c: `CIPHERTEXT-${n}+/==`,
});

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'happy-log-'));
    state.happyHome = home;
});

afterEach(() => {
    delete process.env.HAPPY_SESSION_LOG_SEGMENT_BYTES;
    delete process.env.HAPPY_SESSION_LOG_KEEP_SEGMENTS;
    rmSync(home, { recursive: true, force: true });
});

describe('sessionLog', () => {
    it('round-trips entries with the ciphertext byte-identical', () => {
        const tag = tagFor('roundtrip');
        appendSessionLog(tag, SITE, entry(1, 'in'));
        appendSessionLog(tag, SITE, entry(2));

        const read = readSessionLog(tag, SITE);
        expect(read).toEqual([entry(1, 'in'), entry(2)]);
        expect(read[0].c).toBe('CIPHERTEXT-1+/==');
    });

    it('keys the directory by writer as well as tag, so two machines never share a file', () => {
        expect(sessionLogDir('same-tag', 'machine-a')).not.toBe(sessionLogDir('same-tag', 'machine-b'));
    });

    it('stops at a torn line and recovers by truncating it on the next append', () => {
        const tag = tagFor('torn');
        appendSessionLog(tag, SITE, entry(1));
        appendSessionLog(tag, SITE, entry(2));

        // Simulate a crash mid-append: a partial line with no trailing newline.
        const dir = sessionLogDir(tag, SITE);
        const segment = join(dir, readdirSync(dir)[0]);
        appendFileSync(segment, '{"id":"id-3","localId":"local-3","dir":"out"');

        // The reader returns everything before the tear and stops cleanly.
        expect(readSessionLog(tag, SITE)).toEqual([entry(1), entry(2)]);

        // The writer drops the partial line rather than appending after it, so what was
        // unreachable becomes reachable again.
        appendSessionLog(tag, SITE, entry(4));
        expect(readSessionLog(tag, SITE)).toEqual([entry(1), entry(2), entry(4)]);
        expect(readFileSync(segment, 'utf8').endsWith('\n')).toBe(true);
    });

    it('rotates on size and prunes the oldest segments', () => {
        process.env.HAPPY_SESSION_LOG_SEGMENT_BYTES = '200';
        process.env.HAPPY_SESSION_LOG_KEEP_SEGMENTS = '2';
        const tag = tagFor('rotate');

        for (let i = 0; i < 12; i += 1) {
            appendSessionLog(tag, SITE, entry(i));
        }

        const segments = readdirSync(sessionLogDir(tag, SITE));
        expect(segments.length).toBeLessThanOrEqual(2);

        // Whatever survives is still readable end to end.
        const read = readSessionLog(tag, SITE);
        expect(read.length).toBeGreaterThan(0);
        expect(read[read.length - 1]).toEqual(entry(11));
    });

    it('never throws when the log directory cannot be created', () => {
        // A file where the log directory needs to be: every write to it will fail.
        const tag = tagFor('unwritable');
        mkdirSync(join(home, 'session-log'), { recursive: true });
        writeFileSync(sessionLogDir(tag, SITE), 'not a directory', 'utf8');

        expect(() => appendSessionLog(tag, SITE, entry(1))).not.toThrow();
        expect(readSessionLog(tag, SITE)).toEqual([]);
    });

    it('restricts permissions: 0700 on the directory, 0600 on segments', () => {
        const tag = tagFor('perms');
        appendSessionLog(tag, SITE, entry(1));

        const dir = sessionLogDir(tag, SITE);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        const segment = join(dir, readdirSync(dir)[0]);
        expect(statSync(segment).mode & 0o777).toBe(0o600);
    });

    it('prunes whole log directories older than the cutoff, sparing the caller', () => {
        const stale = tagFor('stale');
        const kept = tagFor('kept');
        appendSessionLog(stale, SITE, entry(1));
        appendSessionLog(kept, SITE, entry(2));

        pruneSessionLogs({ maxAgeMs: -1, keepDir: sessionLogDir(kept, SITE) });

        expect(readSessionLog(stale, SITE)).toEqual([]);
        expect(readSessionLog(kept, SITE)).toEqual([entry(2)]);
    });

    describe('incremental reads', () => {
        // Without these the LAN client re-reads and re-decrypts the whole log on every poll, so
        // the cost of a tick grows with the session. The cursor is what makes polling affordable.

        it('returns only what was appended after the cursor', () => {
            const tag = tagFor('cursor');
            appendSessionLog(tag, SITE, entry(1));

            const first = readSessionLogSince(tag, SITE);
            expect(first.entries).toEqual([entry(1)]);
            expect(first.reset).toBe(false);

            appendSessionLog(tag, SITE, entry(2));
            const second = readSessionLogSince(tag, SITE, first.cursor);
            expect(second.entries).toEqual([entry(2)]);
            expect(second.reset).toBe(false);
        });

        it('returns nothing when nothing was appended', () => {
            const tag = tagFor('idle');
            appendSessionLog(tag, SITE, entry(1));

            const idle = readSessionLogSince(tag, SITE, readSessionLogSince(tag, SITE).cursor);
            expect(idle.entries).toEqual([]);
            expect(idle.reset).toBe(false);
        });

        it('falls back to the whole log when the cursor is unusable', () => {
            const tag = tagFor('garbage');
            appendSessionLog(tag, SITE, entry(1));

            const page = readSessionLogSince(tag, SITE, 'not-a-cursor');
            expect(page.entries).toEqual([entry(1)]);
            expect(page.reset).toBe(true);
        });

        it('reports a reset when the cursor segment has been pruned away', () => {
            process.env.HAPPY_SESSION_LOG_SEGMENT_BYTES = '1';
            process.env.HAPPY_SESSION_LOG_KEEP_SEGMENTS = '1';
            const tag = tagFor('pruned');

            appendSessionLog(tag, SITE, entry(1));
            const first = readSessionLogSince(tag, SITE);

            // The next append rotates into a new segment and drops the one the cursor points at.
            appendSessionLog(tag, SITE, entry(2));

            const page = readSessionLogSince(tag, SITE, first.cursor);
            expect(page.reset).toBe(true);
            expect(page.entries).toEqual([entry(2)]);
        });

        // A log longer than one response has to be paged: the entries leave as a single frame, and
        // the relay both refuses to carry one over its frame limit and drops the whole connection
        // when it sees one — which turns a long session into a reconnect loop rather than a read.
        it('pages at the byte budget and resumes exactly where it stopped', () => {
            const tag = tagFor('paging');
            for (let n = 1; n <= 5; n += 1) {
                appendSessionLog(tag, SITE, entry(n));
            }
            const oneEntry = JSON.stringify(entry(1)).length + 1;

            const first = readSessionLogSince(tag, SITE, undefined, oneEntry * 2);
            expect(first.entries).toEqual([entry(1), entry(2)]);
            expect(first.more).toBe(true);

            const second = readSessionLogSince(tag, SITE, first.cursor, oneEntry * 2);
            expect(second.entries).toEqual([entry(3), entry(4)]);
            expect(second.more).toBe(true);

            const third = readSessionLogSince(tag, SITE, second.cursor, oneEntry * 2);
            expect(third.entries).toEqual([entry(5)]);
            expect(third.more).toBe(false);
        });

        it('delivers an entry larger than the budget rather than stalling the reader on it', () => {
            const tag = tagFor('oversized');
            appendSessionLog(tag, SITE, entry(1));

            const page = readSessionLogSince(tag, SITE, undefined, 1);
            expect(page.entries).toEqual([entry(1)]);
            expect(page.more).toBe(false);
        });

        it('holds the cursor before a torn line so the repair is still delivered', () => {
            const tag = tagFor('torn-cursor');
            appendSessionLog(tag, SITE, entry(1));

            const dir = sessionLogDir(tag, SITE);
            appendFileSync(join(dir, readdirSync(dir)[0]), '{"id":"id-2"');

            const page = readSessionLogSince(tag, SITE);
            expect(page.entries).toEqual([entry(1)]);

            // The writer drops the partial line; whatever lands there next must not be skipped.
            appendSessionLog(tag, SITE, entry(3));
            expect(readSessionLogSince(tag, SITE, page.cursor).entries).toEqual([entry(3)]);
        });
    });
});
