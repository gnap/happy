/**
 * Session Metadata Factory
 *
 * Creates session state and metadata objects for all backends (Claude, Codex, Gemini).
 * This follows DRY principles by providing a single implementation for all backends.
 *
 * @module createSessionMetadata
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { dirname, resolve } from 'node:path';

import type { AgentState, Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { SandboxConfig } from '@/persistence';
import { BUILD_VERSION } from '../version';

/**
 * Backend flavor identifier for session metadata.
 */
export type BackendFlavor = 'claude' | 'codex' | 'gemini' | 'cursor' | 'cursor-acp' | 'acp-cursor' | 'opencode' | 'acp';

/**
 * Options for creating session metadata.
 */
export interface CreateSessionMetadataOptions {
    /** Backend flavor (claude, codex, gemini) */
    flavor: BackendFlavor;
    /** Machine ID for server identification */
    machineId: string;
    /** How the session was started */
    startedBy?: 'daemon' | 'terminal';
    /** Workspace path (agent cwd); defaults to process.cwd() when not set */
    path?: string;
    /** Active sandbox config for the session, or undefined when not used */
    sandbox?: SandboxConfig;
    /** Whether the backend runs with "dangerously skip permissions" behavior */
    dangerouslySkipPermissions?: boolean;
}

/**
 * Result containing both state and metadata for session creation.
 */
export interface SessionMetadataResult {
    /** Agent state for session */
    state: AgentState;
    /** Session metadata */
    metadata: Metadata;
}

export interface GitInfo {
    /** Absolute path to the main repo (worktree: parsed from .git file; main repo: cwd) */
    projectPath: string;
    /** Current git branch name (both main repo and worktrees) */
    branchName?: string;
    /** True if this is a git worktree (main repo has .git/ directory, worktree has .git file) */
    isWorktree: boolean;
}

export function detectWorktree(cwd: string): GitInfo | null {
    const gitFile = resolve(cwd, '.git');
    try {
        if (!existsSync(gitFile)) return null;

        let branchName: string | undefined;
        try {
            branchName = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim() || undefined;
        } catch { /* non-fatal */ }

        const stat = statSync(gitFile);
        if (stat.isFile()) {
            // Worktree: .git is a file containing "gitdir: /path/to/main/.git/worktrees/name"
            const content = readFileSync(gitFile, 'utf-8');
            const m = content.match(/^gitdir:\s*(.+)$/m);
            if (!m) return null;
            const gitdir = m[1].trim();
            const worktreesIdx = gitdir.indexOf('/.git/worktrees/');
            if (worktreesIdx < 0) return null;
            const projectPath = gitdir.slice(0, worktreesIdx);
            return { projectPath, branchName, isWorktree: true };
        }

        // Main repo: .git is a directory — projectPath is its own cwd
        return { projectPath: cwd, branchName, isWorktree: false };
    } catch {
        return null;
    }
}

/**
 * Creates session state and metadata for backend agents.
 *
 * This utility consolidates the common session metadata creation logic used by
 * Codex and Gemini backends, ensuring consistency across all backend implementations.
 *
 * @param opts - Options specifying flavor, machineId, and startedBy
 * @returns Object containing state and metadata for session creation
 *
 * @example
 * ```typescript
 * const { state, metadata } = createSessionMetadata({
 *     flavor: 'gemini',
 *     machineId: settings.machineId,
 *     startedBy: opts.startedBy
 * });
 *
 * const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
 * ```
 */
export function createSessionMetadata(opts: CreateSessionMetadataOptions): SessionMetadataResult {
    const state: AgentState = {
        controlledByUser: false,
    };

    const cwd = opts.path !== undefined ? resolve(opts.path) : process.cwd();
    const worktree = detectWorktree(cwd);

    const metadata: Metadata = {
        path: cwd,
        host: os.hostname(),
        version: BUILD_VERSION,
        os: os.platform(),
        machineId: opts.machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: opts.flavor,
        sandbox: opts.sandbox?.enabled ? opts.sandbox : null,
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions ?? null,
        ...(worktree ? {
            projectPath: worktree.projectPath,
            branchName: worktree.branchName,
            isWorktree: worktree.isWorktree,
        } : {}),
    };

    return { state, metadata };
}
