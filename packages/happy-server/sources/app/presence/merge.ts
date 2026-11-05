import type { SessionPresence } from "@/app/presence/sessionCache";

/**
 * The presence a list response should show.
 *
 * `active`/`lastActiveAt` in the database are checkpoints, not the current answer: with
 * transition-driven updates a live session can have an old timestamp for the whole of a long
 * turn. The in-memory presence is the authoritative answer for anyone currently connected; the
 * row is the fallback for a server that has just started and has not seen the session yet.
 *
 * `thinking` has no database column at all, so it comes only from presence and a missing entry
 * means idle.
 */
export function withSessionPresence<T extends { id: string; active: boolean; lastActiveAt: Date }>(
    row: T,
    presence: SessionPresence | null,
): T & { active: boolean; activeAt: number; thinking: boolean; thinkingAt: number } {
    return {
        ...row,
        active: presence?.active ?? row.active,
        activeAt: presence?.activeAt ?? row.lastActiveAt.getTime(),
        thinking: presence?.thinking ?? false,
        thinkingAt: presence?.thinkingAt ?? 0,
    };
}
