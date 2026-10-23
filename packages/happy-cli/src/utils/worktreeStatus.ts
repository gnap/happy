/**
 * What the working tree looks like, computed where the tree is.
 *
 * The App used to ask for this over a remote `bash`: a round trip to the machine for four git
 * commands, repeated on a timer and on every turn end, and failing with "socket has been
 * disconnected" whenever the daemon channel was not up — while the session process sits *in* the
 * directory and could answer for free.
 *
 * So the session computes it, when something it already sees says the tree may have moved: a tool
 * result for one of the tools that can write. The numbers go into the session's metadata, which
 * the App already receives and decrypts; the shape is the one its badge has always used.
 */

import { execFile } from 'node:child_process';
import { logger } from '@/ui/logger';

export type WorktreeStatus = {
    branch: string | null;
    isDirty: boolean;
    modifiedCount: number;
    untrackedCount: number;
    stagedCount: number;
    lastUpdatedAt: number;
    stagedLinesAdded: number;
    stagedLinesRemoved: number;
    unstagedLinesAdded: number;
    unstagedLinesRemoved: number;
    linesAdded: number;
    linesRemoved: number;
    linesChanged: number;
    upstreamBranch: string | null;
    aheadCount: number;
    behindCount: number;
    stashCount: number;
};

/**
 * Tools whose result means the working tree may have changed.
 *
 * The edit family is obvious. The command tools are here because a shell command can rewrite the
 * tree without any edit tool being called — `git checkout`, a formatter, a package install — and a
 * status that ignores those would be wrong exactly when it matters. A tool that only reads leaves
 * the status alone, and the watcher coalesces the rest.
 */
const WORKTREE_CHANGING_TOOLS: ReadonlySet<string> = new Set([
    'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
    'CursorEdit', 'CursorWrite', 'CodexPatch', 'GeminiPatch', 'edit',
    'Bash', 'CursorBash', 'CodexBash', 'execute', 'shell',
    // A Task's edits happen inside the subagent, so the parent only sees the tool's result.
    'Task', 'Agent',
]);

export function changesWorktree(toolName: string | undefined): boolean {
    return !!toolName && WORKTREE_CHANGING_TOOLS.has(toolName);
}

const GIT_TIMEOUT_MS = 10_000;

function run(cwd: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        execFile('git', args, {
            cwd,
            timeout: GIT_TIMEOUT_MS,
            // A status must not take the index lock and make a concurrent git command wait.
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
            maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout) => {
            resolve(error ? null : stdout);
        });
    });
}

/** `git diff --numstat` output → added/removed lines. Binary files are '-' and count as zero. */
export function parseNumstat(output: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of output.split('\n')) {
        const [a, r] = line.split('\t');
        if (!a || !r) continue;
        const add = Number.parseInt(a, 10);
        const del = Number.parseInt(r, 10);
        if (Number.isFinite(add)) added += add;
        if (Number.isFinite(del)) removed += del;
    }
    return { added, removed };
}

export type ParsedStatus = {
    branch: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    stash: number;
    staged: number;
    modified: number;
    untracked: number;
};

/**
 * `git status --porcelain=v2 --branch --show-stash --untracked-files=normal`.
 *
 * The two status letters are index and working tree; a file can be both. The App counts a file as
 * staged when the index letter is not '.', modified when the worktree letter says it differs, and
 * untracked from the `?` entries — the same classification its own parser made before the counts
 * moved here.
 */
export function parsePorcelainV2(output: string): ParsedStatus {
    let branch: string | null = null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    let stash = 0;
    let staged = 0;
    let modified = 0;
    let untracked = 0;

    for (const line of output.split('\n')) {
        if (line.startsWith('# branch.head ')) {
            const head = line.slice('# branch.head '.length).trim();
            branch = head && head !== '(detached)' && head !== '(initial)' ? head : null;
        } else if (line.startsWith('# branch.upstream ')) {
            upstream = line.slice('# branch.upstream '.length).trim() || null;
        } else if (line.startsWith('# branch.ab ')) {
            const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
            if (match) {
                ahead = Number.parseInt(match[1], 10);
                behind = Number.parseInt(match[2], 10);
            }
        } else if (line.startsWith('# stash ')) {
            stash = Number.parseInt(line.slice('# stash '.length), 10) || 0;
        } else if (line.startsWith('? ')) {
            untracked += 1;
        } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
            // `1 XY …` ordinary, `2 XY …` renamed, `u XY …` unmerged: the two letters follow the
            // kind and a space.
            const index = line[2];
            const worktree = line[3];
            if (index && index !== '.') staged += 1;
            if (worktree && worktree !== '.') modified += 1;
            if (line.startsWith('u ')) {
                // An unmerged file has no single index/worktree state; count it as modified so a
                // conflict is never reported as a clean tree.
                if (worktree === '.') modified += 1;
            }
        }
    }

    return { branch, upstream, ahead, behind, stash, staged, modified, untracked };
}

/** The status of one working tree, or null when it is not a git repository (or git failed). */
export async function readWorktreeStatus(cwd: string): Promise<WorktreeStatus | null> {
    const inside = await run(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (!inside || inside.trim() !== 'true') {
        return null;
    }
    const [statusOut, unstagedOut, stagedOut] = await Promise.all([
        run(cwd, ['status', '--porcelain=v2', '--branch', '--show-stash', '--untracked-files=normal']),
        run(cwd, ['diff', '--numstat', '--no-renames', '--no-ext-diff']),
        run(cwd, ['diff', '--cached', '--numstat', '--no-renames', '--no-ext-diff']),
    ]);
    if (statusOut === null) {
        return null;
    }
    const status = parsePorcelainV2(statusOut);
    const unstaged = parseNumstat(unstagedOut ?? '');
    const staged = parseNumstat(stagedOut ?? '');
    return {
        branch: status.branch,
        isDirty: status.staged + status.modified + status.untracked > 0,
        modifiedCount: status.modified,
        untrackedCount: status.untracked,
        stagedCount: status.staged,
        lastUpdatedAt: Date.now(),
        stagedLinesAdded: staged.added,
        stagedLinesRemoved: staged.removed,
        unstagedLinesAdded: unstaged.added,
        unstagedLinesRemoved: unstaged.removed,
        linesAdded: staged.added + unstaged.added,
        linesRemoved: staged.removed + unstaged.removed,
        linesChanged: staged.added + unstaged.added + staged.removed + unstaged.removed,
        upstreamBranch: status.upstream,
        aheadCount: status.ahead,
        behindCount: status.behind,
        stashCount: status.stash,
    };
}

/** Everything but the timestamp, which changes every run and says nothing about the tree. */
export function sameWorktreeStatus(a: WorktreeStatus | null | undefined, b: WorktreeStatus | null | undefined): boolean {
    if (!a || !b) return a === b;
    return a.branch === b.branch
        && a.isDirty === b.isDirty
        && a.modifiedCount === b.modifiedCount
        && a.untrackedCount === b.untrackedCount
        && a.stagedCount === b.stagedCount
        && a.stagedLinesAdded === b.stagedLinesAdded
        && a.stagedLinesRemoved === b.stagedLinesRemoved
        && a.unstagedLinesAdded === b.unstagedLinesAdded
        && a.unstagedLinesRemoved === b.unstagedLinesRemoved
        && a.upstreamBranch === b.upstreamBranch
        && a.aheadCount === b.aheadCount
        && a.behindCount === b.behindCount
        && a.stashCount === b.stashCount;
}

/**
 * The debounce and the floor between runs.
 *
 * A turn can call twenty tools in a row; twenty `git status` runs would be pure cost, and each
 * published status is a full metadata rewrite that the server sequences for the user. The trailing
 * debounce settles after a burst, and the floor keeps a long editing spree to a handful of updates
 * a minute.
 */
const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_MIN_INTERVAL_MS = 15_000;

/**
 * Computes the status after the tree may have moved, and publishes it only when it changed.
 *
 * `read` is injected so the coalescing can be tested without a repository. The timer is unref'd so
 * a pending status never keeps a session process alive.
 */
export class WorktreeStatusWatcher {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastRunAt = 0;
    private lastPublished: WorktreeStatus | null = null;
    private stopped = false;
    private running = false;

    constructor(private readonly options: {
        read: () => Promise<WorktreeStatus | null>;
        publish: (status: WorktreeStatus) => void;
        debounceMs?: number;
        minIntervalMs?: number;
        now?: () => number;
    }) {}

    /** Something that can write happened. Coalesced into one run. */
    trigger(): void {
        if (this.stopped) {
            return;
        }
        const now = (this.options.now ?? Date.now)();
        const debounce = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
        const due = Math.max(now + debounce, this.lastRunAt + minInterval);
        if (this.timer !== null) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.run();
        }, Math.max(0, due - now));
        (this.timer as unknown as { unref?: () => void }).unref?.();
    }

    /** Runs now, for a caller that is about to lose the chance (a turn ending, a process stop). */
    async flush(): Promise<void> {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        await this.run();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private async run(): Promise<void> {
        if (this.stopped || this.running) {
            return;
        }
        this.running = true;
        this.lastRunAt = (this.options.now ?? Date.now)();
        try {
            const status = await this.options.read();
            if (!status || this.stopped) {
                return;
            }
            if (sameWorktreeStatus(this.lastPublished, status)) {
                return;
            }
            this.lastPublished = status;
            this.options.publish(status);
        } catch (error) {
            logger.debug('[worktree-status] read failed', { error });
        } finally {
            this.running = false;
        }
    }
}
