import type { DaemonRoute } from './lan/types';

/**
 * One row as a machine's daemon answered it, keyed by server id or — before the server has named
 * the session — by the CLI's tag.
 *
 * The machine's projection (`phase`, `generation`) travels beside the older `isAlive` and
 * `restartingSince` so a row can be drawn without opening a channel to ask: a spawn the daemon
 * has scheduled has no process yet, and a restarting session has none for part of the time, and
 * both are states the App has to draw rather than filter out. `phase` stays a plain string
 * because a newer machine may name one this build has not heard of.
 */
export type DaemonSessionEntry = {
    isAlive: boolean;
    directory: string;
    agent: string;
    via: DaemonRoute;
    /** Which machine answered. A row belongs to one machine; the owner's answer wins by id. */
    machineId: string;
    at: number;
    /** The server's id, when the machine has one for this row; a scheduled row has only a tag. */
    happySessionId?: string;
    tag?: string;
    origin?: 'daemon' | 'server';
    restartingSince?: number;
    desktop?: { required: boolean; available: boolean };
    phase?: string;
    generation?: number;
    observedGeneration?: number;
    observedAt?: number;
    reason?: string;
};

/** What a machine reported for one row, before the store stamps when it heard it. */
export type DaemonSessionReport = Omit<DaemonSessionEntry, 'at'> & { happySessionId?: string };

/**
 * The table the store keeps from one round of answers.
 *
 * A row may be named by its tag alone: the daemon mints the tag before it launches the process,
 * so a spawn it has scheduled is listed before there is a server id to key it by. Dropping those
 * is what made a new session appear only once it was already up — the row arrived with the
 * webhook, not with the spec.
 */
export function daemonSessionRows(
    sessions: readonly DaemonSessionReport[],
    at: number,
): Record<string, DaemonSessionEntry> {
    const rows: Record<string, DaemonSessionEntry> = {};
    for (const session of sessions) {
        const key = session.happySessionId ?? session.tag;
        if (key === undefined) continue;
        rows[key] = {
            ...(session.desktop ? { desktop: session.desktop } : {}),
            isAlive: session.isAlive,
            directory: session.directory,
            agent: session.agent,
            via: session.via,
            machineId: session.machineId,
            ...(session.happySessionId !== undefined ? { happySessionId: session.happySessionId } : {}),
            ...(session.tag !== undefined ? { tag: session.tag } : {}),
            ...(session.origin ? { origin: session.origin } : {}),
            at,
            ...(session.restartingSince !== undefined ? { restartingSince: session.restartingSince } : {}),
            ...(session.phase !== undefined ? { phase: session.phase } : {}),
            ...(session.generation !== undefined ? { generation: session.generation } : {}),
            ...(session.observedGeneration !== undefined ? { observedGeneration: session.observedGeneration } : {}),
            ...(session.observedAt !== undefined ? { observedAt: session.observedAt } : {}),
            ...(session.reason !== undefined ? { reason: session.reason } : {}),
        };
    }
    return rows;
}

/**
 * Drop rows for sessions this account deleted.
 *
 * A deletion is a fact in the machine's lifecycle log; a listing that still names the session has
 * simply not replayed that entry yet. It is not a channel with a different opinion, so there is
 * nothing to reconcile or re-ask — the stale row is dropped and the next listing, one log move
 * later, no longer names it. Without this a deleted session would come back from any channel that
 * was a beat behind, which is exactly what made a delete look like it did nothing.
 *
 * A row with no server id is a spawn the machine has scheduled and cannot be one of these: a
 * deletion is only ever known by the id the server gave.
 */
export function dropDeletedDaemonSessionRows<T extends { happySessionId?: string }>(
    sessions: readonly T[],
    deleted: Readonly<Record<string, number>>,
): T[] {
    return sessions.filter((session) =>
        session.happySessionId === undefined || deleted[session.happySessionId] === undefined);
}

/**
 * How long a scheduled row is worth drawing after the last listing that named it.
 *
 * The daemon's own grace for a spawn is `SESSION_WEBHOOK_TIMEOUT_MS + 30s`; this is a little
 * longer so a row is not dropped here while the machine still expects it. Past it, the spawn is
 * dead and the row is noise.
 */
export const PENDING_SESSION_TTL_MS = 120_000;

/**
 * What a server answer leaves of the daemon's roster.
 *
 * A server refresh says nothing about a session the machine has scheduled but not registered —
 * that row exists on no server yet, so clearing the whole map would make a brand-new session
 * disappear and reappear. Tag-only rows are kept (bounded by the TTL above); rows with a server
 * id are cleared exactly as before, because the server's list is the better source for those.
 */
export function keepPendingDaemonSessionRows(
    list: Record<string, DaemonSessionEntry>,
    now: number,
    ttlMs: number = PENDING_SESSION_TTL_MS,
): Record<string, DaemonSessionEntry> {
    const kept: Record<string, DaemonSessionEntry> = {};
    for (const [key, row] of Object.entries(list)) {
        if (row.happySessionId === undefined && now - row.at < ttlMs) {
            kept[key] = row;
        }
    }
    return kept;
}

/**
 * The machine's projection of a session it registered, kept in memory.
 *
 * Not on the persisted `Session` on purpose: a status is what a machine says now, and freezing it
 * into the list cache would outlive the answer. A cold start rebuilds it from the next listing or
 * the next push; until then readers fall back to the older `isAlive`/`restartingAt` facts.
 */
export type SessionRuntimeEntry = {
    phase?: string;
    generation?: number;
    observedGeneration?: number;
    observedAt?: number;
    reason?: string;
    /** When this entry was last said, so a reader can age the projection out. */
    at: number;
};

/**
 * Merge a batch of machine statements into the runtime store, by server id.
 *
 * A field the statement carries replaces the stored one; a field it omits leaves the store as it
 * was. That is what lets a restart's opening push say phase and generation, and a later push that
 * only clears the timestamp not erase the phase it did not mention.
 */
export function mergeSessionRuntime(
    current: Record<string, SessionRuntimeEntry>,
    entries: readonly (Partial<Omit<SessionRuntimeEntry, 'at'>> & { sessionId: string })[],
    at: number,
): Record<string, SessionRuntimeEntry> {
    const next = { ...current };
    for (const entry of entries) {
        const previous = next[entry.sessionId];
        const merged: SessionRuntimeEntry = { at };
        const phase = entry.phase ?? previous?.phase;
        const generation = entry.generation ?? previous?.generation;
        const observedGeneration = entry.observedGeneration ?? previous?.observedGeneration;
        const observedAt = entry.observedAt ?? previous?.observedAt;
        const reason = entry.reason ?? previous?.reason;
        if (phase !== undefined) merged.phase = phase;
        if (generation !== undefined) merged.generation = generation;
        if (observedGeneration !== undefined) merged.observedGeneration = observedGeneration;
        if (observedAt !== undefined) merged.observedAt = observedAt;
        if (reason !== undefined) merged.reason = reason;
        next[entry.sessionId] = merged;
    }
    return next;
}

/**
 * What the UI can tell apart in a list.
 *
 * A heartbeat moving is not a change the list draws: the summaries differ every few seconds
 * (`at`, `lastHeartbeat`), and rewriting the map for that re-ran the channel signature over every
 * session and rebuilt the list each time. The phase and generation are in here because they are
 * exactly the changes that must redraw.
 */
export function daemonSessionListSignature(list: Record<string, DaemonSessionEntry>): string {
    return Object.keys(list).sort().map((id) => {
        const s = list[id];
        return [id, s.isAlive ? 1 : 0, s.directory, s.agent, s.via, s.machineId, s.origin ?? '', s.tag ?? '',
            s.restartingSince ?? '', s.phase ?? '', s.generation ?? '', s.observedGeneration ?? '',
            s.observedAt ?? '', s.reason ?? '',
            s.desktop?.required ? 1 : 0, s.desktop?.available ? 1 : 0].join('\u0000');
    }).join('\u0001');
}
