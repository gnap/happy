/**
 * Missing per-writer counters in the messages a reader holds.
 *
 * The writer's own `(site, n)` is the only ordering key this needs. The server's `seq` is a
 * parallel, compatibility-only number: it says where the server stored a message, not where its
 * author put it, and a design that addresses gaps by it would make the server the authority. A
 * missing `n` between two held ones names a record the author wrote and this reader does not have.
 *
 * Edges are deliberately not gaps. A window starts and ends wherever it likes, and a counter below
 * the oldest held one is older history, not a loss. The same goes for a record with no stamp: it
 * predates the stamping, and treating its absence as a missing counter would invent losses.
 */

import { findMissingCounters, type WriterIdentity } from './writerIdentity';

export type SessionMessageGap = {
    /** The writer the missing counters belong to. */
    site: string;
    /** The counters between two held messages, ascending. */
    missing: number[];
};

/** The counters missing between two held messages, by writer, in a stable order. */
export function findMessageGaps(
    messages: readonly { writer?: { site: string; n: number } }[],
): SessionMessageGap[] {
    // Grouped first: counters from different writers are independent, and `findMissingCounters`
    // refuses a mixed set rather than guessing which numbers belong together.
    const bySite = new Map<string, WriterIdentity[]>();
    for (const message of messages) {
        if (!message.writer) {
            continue;
        }
        const site = message.writer.site;
        const identity: WriterIdentity = { site, n: message.writer.n };
        const existing = bySite.get(site);
        if (existing) {
            existing.push(identity);
        } else {
            bySite.set(site, [identity]);
        }
    }

    const gaps: SessionMessageGap[] = [];
    for (const [site, identities] of bySite) {
        const missing = findMissingCounters(identities);
        if (missing !== null && missing.length > 0) {
            gaps.push({ site, missing });
        }
    }
    return gaps.sort((a, b) => a.site.localeCompare(b.site));
}
