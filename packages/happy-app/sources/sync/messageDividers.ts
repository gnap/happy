/**
 * Where a conversation should show a time divider, and what it should say.
 *
 * The question a reader has when scrolling back is "when was this said", and the clock on every
 * message answers it badly — too much noise for a conversation that is moving, too little for one
 * that has been sitting for a day. So the divider goes where the *pace* changes: a new day, or a
 * pause long enough that the next message is a new thought. That is what WeChat and Feishu do, and
 * it is a property of position in the conversation, not of any single message.
 */
export type DividerKind = 'none' | 'clock' | 'yesterday' | 'date';

/** A pause this long and the conversation has stopped and started again. */
export const DIVIDER_GAP_MS = 5 * 60 * 1000;

const startOfDay = (at: number): number => {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
};

/**
 * Which divider belongs directly above the message at `at`, given the message below it in the
 * conversation and the current time.
 *
 * `previousAt` is the *older* neighbour, or null at either end of the loaded window — where a
 * divider always belongs: at the top because the conversation continues above into messages this
 * device has not loaded, and at the bottom because the time of the latest message is the first
 * thing a reader looks for and the only one the pace rule would otherwise hide while the
 * conversation is still moving.
 */
export function dividerKindFor(at: number, previousAt: number | null, now: number): DividerKind {
    if (previousAt !== null && at - previousAt < DIVIDER_GAP_MS && startOfDay(at) === startOfDay(previousAt)) {
        return 'none';
    }
    const today = startOfDay(now);
    if (startOfDay(at) === today) {
        return 'clock';
    }
    if (startOfDay(at) === today - 24 * 60 * 60 * 1000) {
        return 'yesterday';
    }
    return 'date';
}

/** `HH:mm`, 24-hour: a divider is a timestamp, not a sentence, so it reads the same everywhere. */
export function formatClock(at: number): string {
    const date = new Date(at);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

/** The date part of a divider older than yesterday, in the reader's locale. */
export function formatDividerDate(at: number, now: number): string {
    const date = new Date(at);
    const sameYear = new Date(now).getFullYear() === date.getFullYear();
    return date.toLocaleDateString(undefined, {
        year: sameYear ? undefined : 'numeric',
        month: 'short',
        day: 'numeric',
    });
}
