import { describe, expect, it } from 'vitest';
import { compareByIdentity, findMissingCounters, parseWriterIdentity } from './writerIdentity';

/** A `role:'session'` record — identity rides inside the envelope. */
function sessionRecord(stamp: Record<string, unknown>) {
    return {
        role: 'session',
        content: { type: 'session', data: { id: 'env1', time: 1, role: 'agent', ev: {}, ...stamp } },
    };
}

/** A legacy `role:'agent'` record — no envelope, so identity sits next to `type`. */
function agentRecord(stamp: Record<string, unknown>) {
    return {
        role: 'agent',
        content: { type: 'cursor', ...stamp },
    };
}

describe('parseWriterIdentity', () => {
    it('reads the triple from inside the envelope of a session record', () => {
        const identity = parseWriterIdentity(sessionRecord({ sid: 'tag-1', site: 'machine-a', n: 7 }));
        expect(identity).toEqual({ sid: 'tag-1', site: 'machine-a', n: 7 });
    });

    it('reads the triple directly off a legacy agent record', () => {
        // The five legacy shapes (cursor/codex/output/acp/session-event) have no envelope, which
        // is exactly why they used to reach the log with no identity at all.
        const identity = parseWriterIdentity(agentRecord({ sid: 'tag-1', site: 'machine-a', n: 8 }));
        expect(identity).toEqual({ sid: 'tag-1', site: 'machine-a', n: 8 });
    });

    it('applies the same rule to both shapes, so a mixed log stays comparable', () => {
        const fromSession = parseWriterIdentity(sessionRecord({ sid: 't', site: 'm', n: 3 }));
        const fromAgent = parseWriterIdentity(agentRecord({ sid: 't', site: 'm', n: 4 }));
        expect(fromSession?.site).toBe(fromAgent?.site);
        expect((fromAgent?.n ?? 0) - (fromSession?.n ?? 0)).toBe(1);
    });

    it('falls back to `content` when a session record carries the stamp unwrapped', () => {
        // `preprocessMessageContent` rewrites the unwrapped shape; the CLI's rule is
        // `content.data ?? content`, so both must resolve.
        const identity = parseWriterIdentity({
            role: 'session',
            content: { sid: 'tag-2', site: 'machine-b', n: 1 },
        });
        expect(identity).toEqual({ sid: 'tag-2', site: 'machine-b', n: 1 });
    });

    it('returns null for a record written before the CLI stamped identity', () => {
        expect(parseWriterIdentity({ role: 'agent', content: { type: 'cursor' } })).toBeNull();
    });

    it('ignores fields of the wrong type rather than trusting them', () => {
        const identity = parseWriterIdentity(agentRecord({ sid: 42, site: 'machine-a', n: '9' }));
        expect(identity).toEqual({ site: 'machine-a' });
    });

    it('tolerates malformed input', () => {
        expect(parseWriterIdentity(null)).toBeNull();
        expect(parseWriterIdentity(undefined)).toBeNull();
        expect(parseWriterIdentity({})).toBeNull();
        expect(parseWriterIdentity({ role: 'agent', content: 'not-an-object' })).toBeNull();
    });
});

describe('compareByIdentity', () => {
    it('orders two records from the same writer by n', () => {
        expect(compareByIdentity({ site: 'm', n: 2 }, { site: 'm', n: 5 })).toBe(-3);
    });

    it('refuses to order across writers, whose counters are independent', () => {
        expect(compareByIdentity({ site: 'a', n: 1 }, { site: 'b', n: 2 })).toBeNull();
    });

    it('refuses to order when either side has no n', () => {
        expect(compareByIdentity({ site: 'm', n: 1 }, { site: 'm' })).toBeNull();
        expect(compareByIdentity(null, { site: 'm', n: 1 })).toBeNull();
    });
});

describe('findMissingCounters', () => {
    it('reports nothing for a contiguous run', () => {
        expect(findMissingCounters([{ site: 'm', n: 0 }, { site: 'm', n: 1 }, { site: 'm', n: 2 }])).toEqual([]);
    });

    it('reports the gap', () => {
        expect(findMissingCounters([{ site: 'm', n: 0 }, { site: 'm', n: 3 }])).toEqual([1, 2]);
    });

    it('is unanswerable when any record lacks n — the absence is not a gap', () => {
        // This is the whole reason the check is gated: an unstamped record would otherwise be
        // reported as a lost message.
        expect(findMissingCounters([{ site: 'm', n: 0 }, { site: 'm' }, { site: 'm', n: 2 }])).toBeNull();
    });

    it('is unanswerable across sites', () => {
        expect(findMissingCounters([{ site: 'a', n: 0 }, { site: 'b', n: 1 }])).toBeNull();
    });

    it('is unanswerable when site is missing', () => {
        expect(findMissingCounters([{ n: 0 }, { n: 1 }])).toBeNull();
    });

    it('handles an empty input', () => {
        expect(findMissingCounters([])).toEqual([]);
    });
});
