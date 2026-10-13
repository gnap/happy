/**
 * What a session is doing besides answering, grouped the way the UI shows it.
 *
 * The CLI publishes one flat list of background tasks (`agentState.backgroundTasks`), each with the
 * `type` it was recorded under — `subagent`, `monitor`, `shell`, `workflow`. Every type is its own
 * group here: a subagent is an agent that can be addressed and answered, a monitor is a watch, a
 * shell command is neither, and counting them together would say "three things are running" without
 * saying which — which is the question the count exists to answer.
 *
 * A type this file has never heard of still gets its own group, because the CLI learns kinds of
 * work on its own schedule and the one thing a count must never do is omit something that is
 * running.
 */

/** A background task as the CLI publishes it. */
export type ActivityTask = { id: string; type: string; status: string; description: string };

/** A group of tasks of one type, as the UI draws one badge per group. */
export type ActivityGroup = {
    /** The CLI's own name for the kind, which the UI uses to pick a glyph and a label. */
    type: string;
    tasks: ActivityTask[];
};

/**
 * The order groups are drawn in, highest first.
 *
 * Fixed rather than derived from the data so a badge does not move when a task of another kind
 * starts: what a reader scans down the session list is badges that stay put.
 */
const TYPE_ORDER = ['subagent', 'monitor', 'shell', 'workflow'] as const;

const orderOf = (type: string): number => {
    const at = (TYPE_ORDER as readonly string[]).indexOf(type);
    return at === -1 ? TYPE_ORDER.length : at;
};

/** The tasks of a session, one group per type present, in a stable order. */
export function groupActivityTasks(tasks: readonly ActivityTask[] | null | undefined): ActivityGroup[] {
    const byType = new Map<string, ActivityTask[]>();
    for (const task of tasks ?? []) {
        const group = byType.get(task.type);
        if (group) {
            group.push(task);
        } else {
            byType.set(task.type, [task]);
        }
    }
    return [...byType.entries()]
        .map(([type, group]) => ({ type, tasks: group }))
        .sort((a, b) => orderOf(a.type) - orderOf(b.type) || a.type.localeCompare(b.type));
}
