import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifecycleLog } from './lifecycleLog';

const logAt = () => new LifecycleLog(join(mkdtempSync(join(tmpdir(), 'happy-lifecycle-')), 'lifecycle.jsonl'));

describe('LifecycleLog', () => {
    it('numbers entries from one, so a reader has a cursor to come back with', () => {
        const log = logAt();
        expect(log.revision()).toBe(0);
        expect(log.record({ op: 'created', tag: 'tag-1', directory: '/w', agent: 'claude' })).toMatchObject({ rev: 1, op: 'created', tag: 'tag-1' });
        expect(log.record({ op: 'deleted', tag: 'tag-1' })).toMatchObject({ rev: 2, op: 'deleted' });
        expect(log.revision()).toBe(2);
    });

    it('hands a reader only what it has not applied', () => {
        // The cursor is the reader's own: how far the log has been replayed is per channel, and this
        // is what lets one be at the newest entry while another is still catching up.
        const log = logAt();
        log.record({ op: 'created', tag: 'a' });
        log.record({ op: 'created', tag: 'b' });
        log.record({ op: 'deleted', tag: 'a' });

        expect(log.entriesSince(0).map((entry) => entry.tag)).toEqual(['a', 'b', 'a']);
        expect(log.entriesSince(2).map((entry) => entry.tag)).toEqual(['a']);
        expect(log.entriesSince(3)).toEqual([]);
    });

    it('records the server id beside the tag once there is one', () => {
        // The tag is what a session has from the moment it is spawned; the id only arrives once the
        // server has answered — which is the stretch this log exists for.
        const log = logAt();
        expect(log.record({ op: 'created', tag: 'tag-1' }).sessionId).toBeUndefined();
        expect(log.record({ op: 'created', tag: 'tag-2', sessionId: 'cmt123' }).sessionId).toBe('cmt123');
    });

    it('drops a torn tail rather than failing the read, and stops there', () => {
        // The only way this file grows is an append, so a line that does not parse is a crash
        // mid-write. Skipping it would silently reorder whatever followed.
        const dir = mkdtempSync(join(tmpdir(), 'happy-lifecycle-'));
        const file = join(dir, 'lifecycle.jsonl');
        const log = new LifecycleLog(file);
        log.record({ op: 'created', tag: 'a' });
        appendFileSync(file, '{"rev":2,"op":"crea', 'utf8');

        expect(log.read().map((entry) => entry.rev)).toEqual([1]);
        expect(log.revision()).toBe(1);
    });

    it('keeps what it has across a restart, which is the point of writing it down', () => {
        const file = join(mkdtempSync(join(tmpdir(), 'happy-lifecycle-')), 'lifecycle.jsonl');
        new LifecycleLog(file).record({ op: 'created', tag: 'a' });
        new LifecycleLog(file).record({ op: 'deleted', tag: 'a' });

        const reopened = new LifecycleLog(file);
        expect(reopened.revision()).toBe(2);
        expect(reopened.read().map((entry) => entry.op)).toEqual(['created', 'deleted']);
    });

    it('reads an empty or absent log as nothing at all', () => {
        const log = logAt();
        expect(log.read()).toEqual([]);
        expect(log.entriesSince(7)).toEqual([]);
        writeFileSync(`${log['file']}`, '\n\n', 'utf8');
        expect(log.read()).toEqual([]);
    });

    it('writes one line per fact, so a reader never has to parse a document', () => {
        const file = join(mkdtempSync(join(tmpdir(), 'happy-lifecycle-')), 'lifecycle.jsonl');
        const log = new LifecycleLog(file);
        log.record({ op: 'created', tag: 'a' });
        log.record({ op: 'deleted', tag: 'a' });

        const lines = readFileSync(file, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines.every((line) => JSON.parse(line).rev >= 1)).toBe(true);
    });
});
