/**
 * What a session is doing besides answering, grouped the way the UI shows it.
 *
 * The CLI publishes one flat list of background tasks (`agentState.backgroundTasks`), each with the
 * `type` it was recorded under — `subagent`, `monitor`, `shell`, `workflow`. That list is the
 * source of truth and it changes whenever the SDK learns a new kind of work, so the grouping here
 * is deliberately forgiving: anything that is not a subagent or a monitor counts as a background
 * task, because "something is still running" is the fact a reader needs, and a kind nobody has
 * taught this file about must not vanish from the count.
 */

/** A background task as the CLI publishes it. */
export type ActivityTask = { id: string; type: string; status: string; description: string };

/** The kinds the App shows counts for. */
export const ACTIVITY_KINDS = ['agents', 'monitors', 'tasks'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export function activityKindOf(task: ActivityTask): ActivityKind {
    if (task.type === 'subagent') {
        return 'agents';
    }
    if (task.type === 'monitor') {
        return 'monitors';
    }
    return 'tasks';
}

/** The tasks of a session, by kind. Every kind is present, empty when the session has none. */
export function groupActivityTasks(tasks: readonly ActivityTask[] | null | undefined): Record<ActivityKind, ActivityTask[]> {
    const grouped: Record<ActivityKind, ActivityTask[]> = { agents: [], monitors: [], tasks: [] };
    for (const task of tasks ?? []) {
        grouped[activityKindOf(task)].push(task);
    }
    return grouped;
}
