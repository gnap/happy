/**
 * Every session this machine knows of, not just the ones it is running right now.
 *
 * The machine's own channels are a peer of the server, not a view onto it, and that obliges them
 * to keep the same kind of record: the server does not forget a session because its process
 * exited, and neither may this. A process ending is a change of liveness. It is not the session
 * ceasing to exist, and only an explicit removal — archiving — may mean that.
 *
 * What this replaced listed the live-process index alone. The consequence was not a missing row
 * but a wrong claim, and it landed exactly when the machine's channels are the only ones left: a
 * reboot kills every session process, the daemon comes back without them, and the LAN and the
 * relay both answered "this machine has no sessions". The App, finding nothing from the machine,
 * fell back to the server's record — which still said active, because a killed process tells
 * nobody — and offered to send to a session that no longer had anywhere to go. The send then
 * failed on a timeout, because a write to a socket whose peer is gone is not a delivery.
 *
 * So the durable store is the base and the live index is the overlay. The store already survives
 * what the index does not: it is written to `daemon.state.json`, reloaded on start, and pruned
 * only by archiving or by a week-old orphan with no directory left to name it.
 */

import type { LanSessionSummary } from './lanServer';

/** The fields of a `PersistedSession` a roster entry is built from. */
export type PersistedSessionEntry = {
    sessionId: string;
    directory?: string;
    sessionTag?: string;
    agent?: string;
    lastHeartbeat?: number;
};

/**
 * Synthetic ids the legacy-state migration writes to hold a directory's last tag.
 *
 * They name a directory rather than a session, so nothing can ask for one and listing them would
 * put rows in the App for sessions that never existed.
 */
const DIRECTORY_PLACEHOLDER_PREFIX = 'dir:';

/**
 * The live sessions, plus every stored one they do not already cover.
 *
 * Liveness comes from the overlay and nothing else: an entry known only from disk is reported not
 * alive, whatever status was written there. The store's own flag cannot be trusted for this — it
 * records what was true when it was last written, and a process killed by a reboot leaves it
 * saying "running" forever. The live index is this daemon's ground truth about what is running,
 * and a session absent from it is, as far as this machine can honestly say, not.
 *
 * Matching is by either name, because the two stores do not always have both: a session has its
 * tag from spawn and its id only once the server answers. Matching on the id alone would list a
 * session twice — once live under its tag, once stored under its id — for the whole window where
 * that is the interesting case.
 */
export function mergeSessionRoster(
    live: readonly LanSessionSummary[],
    persisted: Readonly<Record<string, PersistedSessionEntry>>,
    archived: Readonly<Record<string, number>>,
): LanSessionSummary[] {
    const roster = live.filter((session) => !(session.happySessionId && archived[session.happySessionId]));

    const seenIds = new Set(roster.map((session) => session.happySessionId).filter(Boolean));
    const seenTags = new Set(roster.map((session) => session.tag).filter(Boolean));

    for (const entry of Object.values(persisted)) {
        if (!entry.sessionId || entry.sessionId.startsWith(DIRECTORY_PLACEHOLDER_PREFIX)) {
            continue;
        }
        if (archived[entry.sessionId]) {
            continue;
        }
        // A tag is the evidence that this machine ran the session: the CLI writes one at spawn,
        // and it is what names the log on disk. The store also holds rows seeded from the server's
        // list of what changed — an id this machine has merely heard of, with no tag, no directory
        // and no history behind it. Listing those would have the machine claim sessions that live
        // somewhere else entirely, and every one of them would 404 the moment it was read.
        if (!entry.sessionTag) {
            continue;
        }
        if (seenIds.has(entry.sessionId) || seenTags.has(entry.sessionTag)) {
            continue;
        }
        roster.push({
            happySessionId: entry.sessionId,
            ...(entry.sessionTag ? { tag: entry.sessionTag } : {}),
            directory: entry.directory ?? '',
            agent: entry.agent ?? '',
            // Not recorded on disk, and the restore path alongside this one has always assumed the
            // daemon: a session the daemon did not start is one it could not have written down.
            startedBy: 'daemon',
            isAlive: false,
            ...(entry.lastHeartbeat !== undefined ? { lastHeartbeat: entry.lastHeartbeat } : {}),
        });
        seenIds.add(entry.sessionId);
        if (entry.sessionTag) {
            seenTags.add(entry.sessionTag);
        }
    }

    return roster;
}
