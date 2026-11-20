import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

import { readSessionUid, resolveSessionUid, sessionUidPath } from './sessionUid';

describe('sessionUid', () => {
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'happy-uid-'));
        state.happyHome = home;
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it('mints a uid once and returns the same one on a later start', () => {
        // A resume gives the new process the tag and nothing else. Deriving the uid from the tag
        // would make it a hash; minting it again would rename the lineage on every restart.
        const first = resolveSessionUid('tag-1');
        expect(first).toMatch(/^[0-9a-f-]{36}$/);
        expect(resolveSessionUid('tag-1')).toBe(first);
    });

    it('keeps lineages apart', () => {
        expect(resolveSessionUid('tag-1')).not.toBe(resolveSessionUid('tag-2'));
    });

    it('writes nothing until a session asks for its uid', () => {
        expect(readSessionUid('tag-1')).toBeNull();
        resolveSessionUid('tag-1');
        expect(readSessionUid('tag-1')).not.toBeNull();
    });

    it('treats an empty file as no uid, and mints one over it', () => {
        writeFileSync(sessionUidPath('tag-1'), '   \n', 'utf8');
        const uid = resolveSessionUid('tag-1');
        expect(uid).toMatch(/^[0-9a-f-]{36}$/);
        expect(readSessionUid('tag-1')).toBe(uid);
    });

    it('names the file by a hash, because a tag is unvalidated caller input', () => {
        expect(sessionUidPath('../../etc/passwd').startsWith(state.happyHome)).toBe(true);
        expect(sessionUidPath('../../etc/passwd')).toBe(sessionUidPath('../../etc/passwd'));
    });

    it('still names the session in this process when the write fails', () => {
        // The home is behind a regular file, so both the write and the mkdir fail. A uid that
        // cannot be written down is still better than a session that cannot be named at all.
        const blocker = join(home, 'blocker');
        writeFileSync(blocker, '', 'utf8');
        state.happyHome = join(blocker, 'nested');

        expect(resolveSessionUid('tag-1')).toMatch(/^[0-9a-f-]{36}$/);
    });
});
