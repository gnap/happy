/**
 * Running a daemon-spawned session in its own systemd scope.
 *
 * Sessions used to be plain children of the daemon, and so lived in the daemon's cgroup. Anything a
 * session started — a training pipeline holding tens of gigabytes, say — was accounted to
 * `happy-daemon.service`, and with systemd's default `OOMPolicy=stop` a single OOM kill inside that
 * unit stopped the daemon itself, taking every other session with it. A transient scope gives each
 * session a cgroup of its own under `happy-sessions.slice`, so the daemon's memory fate is its own.
 *
 * `systemd-run --scope` does not fork: it registers the transient scope and then `execve`s the
 * command in place (systemd's `start_transient_scope()`), so the PID handed back to `spawn()` is
 * the session's own. Everything the daemon tracks by PID — the webhook's `hostPid`, the spawn
 * awaiter, the child's exit event and its exit code — keeps working unchanged.
 *
 * Linux only, and only when the switch is on; every other case falls back to the direct spawn.
 */

import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { logger } from '@/ui/logger';
import { buildHappyCliCommand } from '@/utils/spawnHappyCLI';

/** Opt-in switch, read from the daemon's environment (e.g. `~/.config/happy/daemon.env`). */
export const SESSION_SCOPE_ENV = 'HAPPY_DAEMON_SESSION_SCOPE';

/** Where the scopes live. Deliberately not the daemon's own unit, which is the whole point. */
export const SESSION_SCOPE_SLICE = 'happy-sessions.slice';

const SCOPE_UNIT_PREFIX = 'happy-session-';
const SCOPE_MAX_SEED = 48;

export interface SessionScopeMode {
    enabled: boolean;
    /** Why it is on or off, for the one startup log line. */
    reason: string;
    slice: string;
}

const FALSEY = new Set(['', '0', 'false', 'no', 'off']);

/** Whether the switch is asking for scopes. Says nothing about whether they are possible. */
export function isSessionScopeRequested(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = os.platform()): boolean {
    if (platform !== 'linux') {
        return false;
    }
    const value = (env[SESSION_SCOPE_ENV] ?? '').trim().toLowerCase();
    return !FALSEY.has(value);
}

/**
 * Whether this daemon should spawn sessions in scopes.
 *
 * Resolved once at startup and never revisited: a daemon must not mix backends, because a session
 * spawned either way looks identical to the tracker and only the scope unit tells them apart later.
 * A requested-but-impossible scope is a *fallback*, not an error: the sessions still run, directly.
 */
export function resolveSessionScopeMode(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = os.platform(),
    deps: { systemdAvailable: () => boolean; systemdRunAvailable: () => boolean } = {
        systemdAvailable: () => {
            try {
                execFileSync('systemctl', ['--user', '--version'], { stdio: 'ignore', timeout: 2000 });
                return true;
            } catch {
                return false;
            }
        },
        systemdRunAvailable: () => {
            try {
                execFileSync('systemd-run', ['--version'], { stdio: 'ignore', timeout: 2000 });
                return true;
            } catch {
                return false;
            }
        },
    },
): SessionScopeMode {
    if (!isSessionScopeRequested(env, platform)) {
        return { enabled: false, reason: platform === 'linux' ? `${SESSION_SCOPE_ENV} not set` : `platform ${platform}`, slice: SESSION_SCOPE_SLICE };
    }
    if (!deps.systemdAvailable()) {
        return { enabled: false, reason: 'systemd --user not available', slice: SESSION_SCOPE_SLICE };
    }
    if (!deps.systemdRunAvailable()) {
        return { enabled: false, reason: 'systemd-run not available', slice: SESSION_SCOPE_SLICE };
    }
    return { enabled: true, reason: 'enabled', slice: SESSION_SCOPE_SLICE };
}

/**
 * A token safe to embed in a unit name: systemd allows `[A-Za-z0-9:_.-]`, but `/`, whitespace and
 * most unicode are not worth trying to keep, and a name has a hard length budget.
 */
export function sanitizeUnitToken(input: string): string {
    const cleaned = input
        .replace(/[^A-Za-z0-9_.-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[.-]+/, '')
        .replace(/[.-]+$/, '')
        .slice(0, SCOPE_MAX_SEED);
    return cleaned || 'session';
}

/** A unique scope name. The random tail makes a collision with a lingering unit implausible. */
export function buildSessionScopeUnitName(
    seed: string,
    entropy: { now: number; random: string } = { now: Date.now(), random: randomBytes(4).toString('hex') },
): string {
    return `${SCOPE_UNIT_PREFIX}${sanitizeUnitToken(seed)}-${entropy.now.toString(36)}-${entropy.random}.scope`;
}

/**
 * The argv for `systemd-run`.
 *
 * `--` always precedes the command so a session argument that happens to start with `-` is the
 * session's, not systemd-run's. No shell is involved, so nothing needs quoting.
 */
export function buildSystemdRunArgs(params: {
    executable: string;
    argv: string[];
    unitName: string;
    slice?: string;
}): string[] {
    const slice = params.slice ?? SESSION_SCOPE_SLICE;
    return [
        '--user',
        '--scope',
        '--collect',
        '--quiet',
        `--unit=${params.unitName}`,
        `--slice=${slice}`,
        '--',
        params.executable,
        ...params.argv,
    ];
}

/**
 * Spawns the Happy CLI inside its own transient scope.
 *
 * Because `systemd-run --scope` execs the command in place, the returned child is the session
 * itself: its `pid`, `exit` event and exit status are the session's.
 */
export function spawnHappyCLIInSessionScope(
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; unitName: string; slice?: string },
): ChildProcess {
    const { executable, argv } = buildHappyCliCommand(args);
    logger.debug(`[SESSION SCOPE] Spawning ${options.unitName} in ${options.cwd}`);
    return spawn(
        'systemd-run',
        buildSystemdRunArgs({ executable, argv, unitName: options.unitName, slice: options.slice }),
        {
            cwd: options.cwd,
            env: options.env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
}

export type SessionSignalPlan =
    | { kind: 'scope'; unit: string; signal: NodeJS.Signals }
    | { kind: 'pid'; pid: number; signal: NodeJS.Signals };

/**
 * Where a signal for this session should go.
 *
 * A scoped session is signalled through its scope so the whole cgroup goes with it — its children
 * (a pipeline, a build) are the reason the scope exists. A direct session keeps the old behaviour.
 */
export function planSessionSignal(
    session: { pid: number; scopeUnit?: string | null },
    signal: NodeJS.Signals,
): SessionSignalPlan {
    if (session.scopeUnit) {
        return { kind: 'scope', unit: session.scopeUnit, signal };
    }
    return { kind: 'pid', pid: session.pid, signal };
}

/** Sends a signal per the plan, falling back to the PID when systemd cannot do it. */
export function signalSession(session: { pid: number; scopeUnit?: string | null }, signal: NodeJS.Signals): void {
    const plan = planSessionSignal(session, signal);
    if (plan.kind === 'pid') {
        try {
            process.kill(plan.pid, plan.signal);
        } catch {
            // Already gone.
        }
        return;
    }
    execFile(
        'systemctl',
        ['--user', 'kill', '--kill-whom=all', `--signal=${plan.signal}`, plan.unit],
        { timeout: 5000 },
        (error) => {
            if (!error) return;
            logger.debug(`[SESSION SCOPE] systemctl kill ${plan.unit} failed (${error.message}); signalling PID ${session.pid}`);
            try {
                process.kill(session.pid, plan.signal);
            } catch {
                // Already gone.
            }
        },
    );
}

/**
 * The happy-session scope this PID lives in, if any.
 *
 * Read from `/proc` rather than from persisted state so a daemon that has just restarted (or is
 * looking at a session that started under a different switch setting) can still route signals.
 */
export function parseScopeUnitFromCgroup(cgroup: string): string | null {
    const match = cgroup.match(/(happy-session-[A-Za-z0-9_.-]+\.scope)/);
    return match ? match[1] : null;
}

export function scopeUnitFromProcCgroup(pid: number): string | null {
    if (os.platform() !== 'linux') {
        return null;
    }
    try {
        return parseScopeUnitFromCgroup(readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
    } catch {
        return null;
    }
}
