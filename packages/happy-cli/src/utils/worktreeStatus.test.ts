import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    changesWorktree,
    parseNumstat,
    parsePorcelainV2,
    sameWorktreeStatus,
    WorktreeStatusWatcher,
    type WorktreeStatus,
} from './worktreeStatus';

const STATUS: WorktreeStatus = {
    branch: 'main',
    isDirty: true,
    modifiedCount: 1,
    untrackedCount: 1,
    stagedCount: 1,
    lastUpdatedAt: 0,
    stagedLinesAdded: 3,
    stagedLinesRemoved: 0,
    unstagedLinesAdded: 1,
    unstagedLinesRemoved: 2,
    linesAdded: 4,
    linesRemoved: 2,
    linesChanged: 6,
    upstreamBranch: 'origin/main',
    aheadCount: 1,
    behindCount: 0,
    stashCount: 0,
};

describe('parsePorcelainV2', () => {
    it('reads the branch, tracking and stash headers, and both status letters', () => {
        const output = [
            '# branch.oid 1111111',
            '# branch.head main',
            '# branch.upstream origin/main',
            '# branch.ab +2 -3',
            '# stash 1',
            '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
            '1 .M N... 100644 100644 100644 aaa bbb modified.ts',
            '1 MM N... 100644 100644 100644 aaa bbb both.ts',
            '2 R. N... 100644 100644 100644 aaa bbb R100 renamed.ts\toriginal.ts',
            'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
            '? untracked-1.ts',
            '? untracked-2.ts',
            '',
        ].join('\n');

        expect(parsePorcelainV2(output)).toEqual({
            branch: 'main',
            upstream: 'origin/main',
            ahead: 2,
            behind: 3,
            stash: 1,
            // staged: M., MM, R., UU
            staged: 4,
            // modified: .M, MM, UU (the conflict is never reported as a clean tree)
            modified: 3,
            untracked: 2,
        });
    });

    it('reports no branch on a detached head', () => {
        expect(parsePorcelainV2('# branch.head (detached)\n').branch).toBeNull();
    });
});

describe('parseNumstat', () => {
    it('sums text changes and skips binary entries', () => {
        expect(parseNumstat('10\t2\ta.ts\n-\t-\timage.png\n3\t0\tb.ts\n')).toEqual({ added: 13, removed: 2 });
    });
});

describe('changesWorktree', () => {
    it('covers the edit family and the commands that can write', () => {
        for (const tool of ['Edit', 'MultiEdit', 'Write', 'CursorEdit', 'CodexPatch', 'Bash', 'execute', 'Task']) {
            expect(changesWorktree(tool), tool).toBe(true);
        }
        for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', undefined]) {
            expect(changesWorktree(tool), String(tool)).toBe(false);
        }
    });
});

describe('sameWorktreeStatus', () => {
    it('ignores the timestamp, which changes on every run', () => {
        expect(sameWorktreeStatus({ ...STATUS, lastUpdatedAt: 1 }, { ...STATUS, lastUpdatedAt: 999 })).toBe(true);
        expect(sameWorktreeStatus(STATUS, { ...STATUS, modifiedCount: 2 })).toBe(false);
    });
});

describe('WorktreeStatusWatcher', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces a burst into one run and publishes once', async () => {
        vi.useFakeTimers();
        let reads = 0;
        const published: WorktreeStatus[] = [];
        const watcher = new WorktreeStatusWatcher({
            read: async () => { reads += 1; return { ...STATUS, lastUpdatedAt: Date.now() }; },
            publish: (status) => published.push(status),
            debounceMs: 100,
            minIntervalMs: 1_000,
        });

        watcher.trigger();
        watcher.trigger();
        watcher.trigger();
        await vi.advanceTimersByTimeAsync(150);

        expect(reads).toBe(1);
        expect(published).toHaveLength(1);
        watcher.stop();
    });

    it('does not republish a tree that did not change', async () => {
        vi.useFakeTimers();
        let reads = 0;
        const published: WorktreeStatus[] = [];
        const watcher = new WorktreeStatusWatcher({
            read: async () => { reads += 1; return { ...STATUS, lastUpdatedAt: Date.now() }; },
            publish: (status) => published.push(status),
            debounceMs: 100,
            minIntervalMs: 200,
        });

        watcher.trigger();
        await vi.advanceTimersByTimeAsync(150);
        watcher.trigger();
        await vi.advanceTimersByTimeAsync(250);

        expect(reads).toBe(2);
        expect(published).toHaveLength(1);
        watcher.stop();
    });

    it('holds a run until the floor has passed', async () => {
        vi.useFakeTimers();
        let reads = 0;
        const watcher = new WorktreeStatusWatcher({
            read: async () => { reads += 1; return { ...STATUS, modifiedCount: reads }; },
            publish: () => {},
            debounceMs: 100,
            minIntervalMs: 1_000,
        });

        watcher.trigger();
        await vi.advanceTimersByTimeAsync(150);
        expect(reads).toBe(1);

        // The debounce has passed, but the run just happened: this waits for the floor instead.
        watcher.trigger();
        await vi.advanceTimersByTimeAsync(300);
        expect(reads).toBe(1);
        await vi.advanceTimersByTimeAsync(800);
        expect(reads).toBe(2);
        watcher.stop();
    });

    it('flushes on demand, and stops asking after stop', async () => {
        vi.useFakeTimers();
        let reads = 0;
        const watcher = new WorktreeStatusWatcher({
            read: async () => { reads += 1; return { ...STATUS, modifiedCount: reads }; },
            publish: () => {},
            debounceMs: 10_000,
            minIntervalMs: 10_000,
        });

        watcher.trigger();
        await watcher.flush();
        expect(reads).toBe(1);

        watcher.stop();
        watcher.trigger();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(reads).toBe(1);
    });
});
