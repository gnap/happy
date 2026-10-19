import { describe, expect, it } from 'vitest';
import { mergeSessionRoster, type PersistedSessionEntry } from './sessionRoster';
import type { LanSessionSummary } from './lanServer';

const liveSession = (over: Partial<LanSessionSummary> = {}): LanSessionSummary => ({
    happySessionId: 'live-1',
    tag: 'tag-live-1',
    directory: '/w/live',
    agent: 'cursor',
    startedBy: 'daemon',
    isAlive: true,
    ...over,
});

const stored = (over: Partial<PersistedSessionEntry> = {}): PersistedSessionEntry => ({
    sessionId: 'stored-1',
    directory: '/w/stored',
    sessionTag: 'tag-stored-1',
    agent: 'cursor',
    ...over,
});

describe('mergeSessionRoster', () => {
    it('keeps a session the daemon has only on disk, and says it is not alive', () => {
        const roster = mergeSessionRoster([], { 'stored-1': stored() }, {});
        expect(roster).toEqual([{
            happySessionId: 'stored-1',
            tag: 'tag-stored-1',
            directory: '/w/stored',
            agent: 'cursor',
            startedBy: 'daemon',
            isAlive: false,
        }]);
    });

    it('reports a stored session as not alive even when the store still says running', () => {
        // The reboot case: the process was killed, so nothing ever rewrote the status.
        const roster = mergeSessionRoster([], { 'stored-1': stored({ lastHeartbeat: 42 }) }, {});
        expect(roster[0].isAlive).toBe(false);
        expect(roster[0].lastHeartbeat).toBe(42);
    });

    it('lets the live entry win, so a running session is not also listed as stopped', () => {
        const roster = mergeSessionRoster(
            [liveSession()],
            { 'live-1': stored({ sessionId: 'live-1', sessionTag: 'tag-live-1' }) },
            {},
        );
        expect(roster).toHaveLength(1);
        expect(roster[0].isAlive).toBe(true);
    });

    it('matches on the tag too, for a session the server has not named yet', () => {
        // Live under its tag with no id; stored under the id the server later issued.
        const roster = mergeSessionRoster(
            [liveSession({ happySessionId: undefined, tag: 'tag-x' })],
            { 'id-x': stored({ sessionId: 'id-x', sessionTag: 'tag-x' }) },
            {},
        );
        expect(roster).toHaveLength(1);
        expect(roster[0].tag).toBe('tag-x');
    });

    it('drops archived sessions from both sides — the one removal that means gone', () => {
        const roster = mergeSessionRoster(
            [liveSession({ happySessionId: 'archived-live' })],
            { 'archived-stored': stored({ sessionId: 'archived-stored' }) },
            { 'archived-live': 1, 'archived-stored': 1 },
        );
        expect(roster).toEqual([]);
    });

    it('skips the dir: placeholders the legacy migration writes', () => {
        const roster = mergeSessionRoster([], { 'dir:/w/x': stored({ sessionId: 'dir:/w/x' }) }, {});
        expect(roster).toEqual([]);
    });

    it('fills a stored session missing its directory or agent rather than dropping it', () => {
        const roster = mergeSessionRoster(
            [],
            { 'bare-1': { sessionId: 'bare-1', sessionTag: 'tag-bare-1' } },
            {},
        );
        expect(roster).toEqual([{
            happySessionId: 'bare-1',
            tag: 'tag-bare-1',
            directory: '',
            agent: '',
            startedBy: 'daemon',
            isAlive: false,
        }]);
    });

    it('skips a row seeded from the server, which this machine never ran', () => {
        // `listChangedSessions` seeds an id with no tag and no directory. There is no log behind
        // one, so listing it would make the machine claim a session that lives elsewhere.
        const roster = mergeSessionRoster([], { 'elsewhere-1': { sessionId: 'elsewhere-1', sessionTag: '' } }, {});
        expect(roster).toEqual([]);
    });

    it('keeps both when the stored session is a different one', () => {
        const roster = mergeSessionRoster([liveSession()], { 'stored-1': stored() }, {});
        expect(roster.map((s) => s.happySessionId)).toEqual(['live-1', 'stored-1']);
        expect(roster.map((s) => s.isAlive)).toEqual([true, false]);
    });
});
