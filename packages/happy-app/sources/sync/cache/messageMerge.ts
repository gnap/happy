/**
 * The messages a cache save should leave on disk: everything already there, plus everything new.
 *
 * A save used to replace the record with whatever the in-memory window happened to hold. The window
 * is not the cache — it is what is on screen — and it can be narrower than what was written before: a
 * session opened on a narrow window, a tail read after a long absence, a truncated tail. Writing it
 * over the record deleted the rest, which is how messages that had been cached disappeared.
 *
 * The native backend has never had this problem because its rows are insert-only; this is the same
 * rule for the key-value store, applied as a union keyed by the message's own identity.
 */
import type { Message } from '../typesMessage';

const keyOf = (message: Message): string => {
    const identity = message as { id?: string; localId?: string };
    return identity.id ?? identity.localId ?? JSON.stringify(message);
};

/**
 * `incoming` wins where both sides hold the same message: it is the copy the store is showing, and a
 * message can be edited (a tool result arriving) between saves.
 */
export function mergeForCache(existing: readonly Message[], incoming: readonly Message[]): Message[] {
    if (existing.length === 0) {
        return [...incoming];
    }
    const merged = new Map<string, Message>();
    for (const message of existing) {
        merged.set(keyOf(message), message);
    }
    for (const message of incoming) {
        merged.set(keyOf(message), message);
    }
    return [...merged.values()];
}

/** The newest `limit` messages, oldest first — what a reader wants to hydrate. */
export function newestMessages(messages: readonly Message[], limit: number | undefined): Message[] {
    const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    return limit && limit > 0 ? ordered.slice(-limit) : ordered;
}
