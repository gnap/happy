import { describe, expect, it } from 'vitest';
import { sessionTagOf } from './sessionTag';

describe('sessionTagOf', () => {
    it('names a session its live process is running', () => {
        const live = [{ happySessionId: 'sess-1', sessionTag: 'tag-1' }];
        expect(sessionTagOf('sess-1', live, {})).toBe('tag-1');
    });

    it('names a session whose process is gone, from what the last run wrote down', () => {
        // The whole point: a daemon that has restarted holds no process for a session, and its log
        // is still on disk. Resolving through the process index alone is what made the LAN channel
        // fail at exactly the moment it is the only one left.
        expect(sessionTagOf('sess-1', [], { 'sess-1': { sessionTag: 'tag-1' } })).toBe('tag-1');
    });

    it('prefers the live process, which is the one currently writing that log', () => {
        const live = [{ happySessionId: 'sess-1', sessionTag: 'tag-new' }];
        expect(sessionTagOf('sess-1', live, { 'sess-1': { sessionTag: 'tag-old' } })).toBe('tag-new');
    });

    it('falls through a live entry that carries no tag', () => {
        // Same session under both stores, and only one of them has the name.
        const live = [{ happySessionId: 'sess-1' }];
        expect(sessionTagOf('sess-1', live, { 'sess-1': { sessionTag: 'tag-1' } })).toBe('tag-1');
    });

    it('treats an empty tag as absent, because it addresses no log', () => {
        expect(sessionTagOf('sess-1', [], { 'sess-1': { sessionTag: '' } })).toBeNull();
        expect(sessionTagOf('sess-1', [{ happySessionId: 'sess-1', sessionTag: '' }], {})).toBeNull();
    });

    it('does not name a session neither store has heard of', () => {
        const live = [{ happySessionId: 'sess-2', sessionTag: 'tag-2' }];
        expect(sessionTagOf('sess-1', live, { 'sess-2': { sessionTag: 'tag-2' } })).toBeNull();
    });

    it('refuses an empty id rather than matching an entry that has no id either', () => {
        expect(sessionTagOf('', [{ sessionTag: 'tag-1' }], {})).toBeNull();
    });
});
