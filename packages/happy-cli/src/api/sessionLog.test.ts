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

import { appendSessionLog, readSessionLog, sessionLogDir, pruneSessionLogs, type SessionLogEntry } from './sessionLog';

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
});
