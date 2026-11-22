/**
 * Deliver a message into a Claude Code session through its own inbox socket.
 *
 * Every Claude Code session that has cross-session messaging enabled binds a Unix-socket inbox
 * and lists it in `~/.claude/sessions/<pid>.json`. Posting one user frame there is the same path
 * another Claude session takes when it messages this one: the text becomes a peer turn in that
 * session, its response flows through the session's normal output, and nobody has to synthesize
 * an inbox prompt on the server.
 *
 * Discovery is process-based rather than path-based: the daemon knows the Happy process it
 * spawned, and the registry key is the Claude process, which is one of that process's
 * descendants. That keeps two sessions in the same directory apart and needs no launch flag,
 * so older Claude versions that do not know about the socket simply produce no candidate.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDaemonState } from '@/persistence';
import { logger } from '@/ui/logger';

type SessionRegistryEntry = {
    pid?: number;
    messagingSocketPath?: string;
    startedAt?: number;
    entrypoint?: string;
};

type PeerSocketCandidate = {
    socketPath: string;
    startedAt: number;
};

/** Agents that do not speak Claude Code's peer protocol never have an inbox socket. */
const NON_CLAUDE_AGENTS = new Set(['cursor', 'cursor-acp', 'acp-cursor', 'codex', 'gemini', 'acp']);

function claudeSessionsDir(): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(configDir, 'sessions');
}

/**
 * PIDs of every process below `root`, including nested wrappers (`happy` → `node` → `claude`).
 *
 * `ps` is used instead of `/proc` because the daemon runs on macOS and Linux, and a single
 * snapshot is cheap enough for a one-shot send. Native Windows has no Unix socket here (the
 * inbox is an authenticated named pipe), so it reports no descendants and falls back.
 */
export function collectDescendantPids(root: number): Set<number> {
    const descendants = new Set<number>();
    if (process.platform === 'win32' || !Number.isInteger(root) || root <= 0) {
        return descendants;
    }

    let output: string;
    try {
        output = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
            encoding: 'utf8',
            timeout: 2_000,
        });
    } catch {
        return descendants;
    }

    const childrenByParent = new Map<number, number[]>();
    for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        const siblings = childrenByParent.get(ppid);
        if (siblings) {
            siblings.push(pid);
        } else {
            childrenByParent.set(ppid, [pid]);
        }
    }

    const queue = [...(childrenByParent.get(root) ?? [])];
    while (queue.length > 0) {
        const pid = queue.shift()!;
        if (descendants.has(pid)) continue;
        descendants.add(pid);
        queue.push(...(childrenByParent.get(pid) ?? []));
    }
    return descendants;
}

/**
 * Pick the socket among the registry entries that belong to this process tree.
 *
 * A session can briefly appear twice while a restart replaces its Claude process; the newest
 * entry is the one that is actually listening.
 */
export function selectPeerSocket(
    entries: readonly SessionRegistryEntry[],
    descendants: ReadonlySet<number>,
): string | null {
    let best: PeerSocketCandidate | null = null;
    for (const entry of entries) {
        if (typeof entry.pid !== 'number' || !descendants.has(entry.pid)) continue;
        if (typeof entry.messagingSocketPath !== 'string' || entry.messagingSocketPath.length === 0) continue;
        if (!existsSync(entry.messagingSocketPath)) continue;
        const startedAt = typeof entry.startedAt === 'number' ? entry.startedAt : 0;
        if (!best || startedAt > best.startedAt) {
            best = { socketPath: entry.messagingSocketPath, startedAt };
        }
    }
    return best?.socketPath ?? null;
}

function readSessionRegistry(): SessionRegistryEntry[] {
    const dir = claudeSessionsDir();
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }

    const entries: SessionRegistryEntry[] = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
            const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SessionRegistryEntry;
            if (parsed && typeof parsed === 'object') {
                entries.push(parsed);
            }
        } catch {
            // A session that is starting or exiting can leave a half-written file. It has no
            // socket this send could use, so skip it rather than failing the whole lookup.
        }
    }
    return entries;
}

/** Where the target Happy session's Claude process listens, or null when there is no socket. */
export async function resolvePeerSocketPath(sessionId: string): Promise<string | null> {
    if (process.platform === 'win32') {
        return null;
    }

    const state = await readDaemonState();
    const entry = state?.sessions?.[sessionId];
    if (!entry || typeof entry.pid !== 'number' || entry.pid <= 0) {
        return null;
    }
    if (entry.agent && NON_CLAUDE_AGENTS.has(entry.agent)) {
        return null;
    }
    // Sandboxed sessions launch with bypassPermissions and cannot take `--settings`, so inbound
    // peer messages would be held for an approval the App has no way to give. Use the server
    // injection path there instead.
    if (entry.sandbox?.enabled) {
        return null;
    }

    const descendants = collectDescendantPids(entry.pid);
    if (descendants.size === 0) {
        return null;
    }
    return selectPeerSocket(readSessionRegistry(), descendants);
}

/**
 * Write one peer frame and close.
 *
 * The protocol has no acknowledgement: a write that reached the socket is as much confirmation
 * as this direction offers. Any failure — no socket, refused connection, timeout — returns false
 * so the caller can fall back to the server path.
 */
export function writePeerMessage(socketPath: string, text: string, timeoutMs = 3_000): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const socket = createConnection({ path: socketPath });
        const finish = (delivered: boolean) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            socket.destroy();
            resolve(delivered);
        };
        timer = setTimeout(() => finish(false), timeoutMs);

        socket.once('error', (error) => {
            logger.debug(`[peerSocket] write failed for ${socketPath}: ${error.message}`);
            finish(false);
        });
        socket.once('connect', () => {
            const frame = JSON.stringify({
                type: 'user',
                // Addressed the way Claude Code names peers; the App draws the origin, not the id.
                from: 'uds:happy-cli',
                msg_id: randomUUID(),
                message: {
                    role: 'user',
                    content: text,
                },
            }) + '\n';
            socket.write(frame, (error) => finish(!error));
        });
    });
}

/** True when the message was handed to the target session's inbox socket. */
export async function sendA2aOverPeerSocket(sessionId: string, text: string): Promise<boolean> {
    const socketPath = await resolvePeerSocketPath(sessionId);
    if (!socketPath) {
        return false;
    }
    const delivered = await writePeerMessage(socketPath, text);
    if (delivered) {
        logger.debug(`[peerSocket] delivered A2A message to ${sessionId} via ${socketPath}`);
    }
    return delivered;
}
