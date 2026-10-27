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

/**
 * A background task as the CLI publishes it.
 *
 * `description` is Claude Code's name for the task. For a background command that name is sometimes
 * the command line itself — the model gave the tool no description of its own — which is why the
 * command travels beside it rather than inside it: the UI shows the name it was given and the
 * command underneath, so a task with no name of its own still reads as something other than a wall
 * of shell.
 */
export type ActivityTask = {
    id: string;
    type: string;
    status: string;
    description: string;
    /** Shell tasks: the command line. */
    command?: string;
    /** Subagent tasks: which agent definition it runs. */
    agentType?: string;
    /** Monitor / MCP tasks: where it watches. */
    server?: string;
    tool?: string;
    /** Workflow tasks. */
    name?: string;
    /**
     * When this task stops on its own, when the tool that started it said so.
     *
     * Only monitors (`timeout_ms`, unless persistent) and background commands (`timeout`) carry
     * one; subagents and workflows run until they are done. Absent means no deadline, not "unknown".
     */
    deadlineAt?: number;
    /** When the task was first seen running. */
    startedAt?: number;
};

/**
 * The one piece of detail worth showing under a task's name, by kind: what a command runs, which
 * agent definition a subagent uses, what a monitor watches.
 */
function detailOf(task: ActivityTask): string | undefined {
    const candidates = [task.command, task.agentType, task.server && task.tool ? `${task.server} · ${task.tool}` : undefined, task.name];
    for (const candidate of candidates) {
        const trimmed = candidate?.trim();
        if (trimmed !== undefined && trimmed.length > 0) {
            return trimmed;
        }
    }
    return undefined;
}

/**
 * The line to show for a task, and the detail underneath it, when there is one.
 *
 * The name Claude Code gave the task comes first because that is the readable thing; the detail is
 * suppressed when it says the same thing, which is common for a background command whose name *is*
 * its command line. A task with no name at all is named by its detail instead, so nothing is ever
 * shown as a bare type.
 */
export function activityTaskText(task: ActivityTask): { title: string; detail?: string } {
    const title = task.description.trim();
    const detail = detailOf(task);
    if (title.length === 0) {
        return { title: detail === undefined ? canonicalActivityType(task.type) : command(detail), detail: undefined };
    }
    if (detail === title) {
        // Claude Code named the task after what it runs: there is no name to show, so the line says
        // it is a command rather than dressing a command up as one.
        return { title: command(title), detail: undefined };
    }
    return detail !== undefined ? { title, detail } : { title };
}

/** A command, marked as a command, so a line that is one is never read as a name. */
const command = (line: string): string => `$ ${line}`;

/** A group of tasks of one type, as the UI draws one badge per group. */
export type ActivityGroup = {
    /** The CLI's own name for the kind, which the UI uses to pick a glyph and a label. */
    type: string;
    tasks: ActivityTask[];
};

/**
 * The names Claude Code uses for the same kinds of work, folded onto one.
 *
 * It reports a task twice over its life and does not use the same word both times: the
 * `task_started` frame introduces it as `local_bash` / `local_agent`, and the snapshot at the end of
 * the turn calls the very same task (`task_id` and all) a `shell` or a `subagent`. Grouping by the
 * raw value would split one task into two kinds, relabel it mid-flight, and — worse — make the count
 * move without anything having started or stopped.
 *
 * The aliases are also what an older CLI on another machine sends, which is why the vocabulary is
 * accepted on this side rather than only normalised where it is written.
 */
const TYPE_ALIASES: Record<string, string> = {
    local_bash: 'shell',
    local_agent: 'subagent',
    local_monitor: 'monitor',
    local_workflow: 'workflow',
    agent: 'subagent',
};

/** The kind a task belongs to, whatever the CLI called it. */
export function canonicalActivityType(type: string): string {
    return TYPE_ALIASES[type] ?? type;
}

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
        const type = canonicalActivityType(task.type);
        const group = byType.get(type);
        if (group) {
            group.push(task);
        } else {
            byType.set(type, [task]);
        }
    }
    return [...byType.entries()]
        .map(([type, group]) => ({ type, tasks: group }))
        .sort((a, b) => orderOf(a.type) - orderOf(b.type) || a.type.localeCompare(b.type));
}
