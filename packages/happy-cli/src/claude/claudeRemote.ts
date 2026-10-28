import { ClaudeSession, type ClaudeSessionOpts } from './claudeSession';
import { logger } from '@/lib';

// Reached for by name from the tool tests and from the launcher.
export {
    ClaudeSession,
    normalizeTaskType,
    taskTypeOf,
    mergeTask,
    toolTimeoutMs,
    type BackgroundTaskForApp,
    type ClaudeSessionOpts,
} from './claudeSession';

/**
 * The live process per happy session.
 *
 * One entry at most per session, because a second process for the same session is exactly the thing
 * this registry exists to prevent: two processes on one conversation is two writers on one
 * transcript, and the ids the App has already been shown would stop meaning anything.
 */
const liveSessions = new Map<string, { session: ClaudeSession; spawnKey: string }>();

/**
 * The session a process belongs to — what the registry is keyed by.
 *
 * Deliberately not what the process is spawned with: the spawn key changes on things a session
 * survives (a profile applied mid-session bumps the env generation), and keying by it would leave
 * the process spawned under the old key running, unheard from and never ended, beside the new one.
 */
function sessionKeyOf(opts: ClaudeSessionOpts): string {
    return opts.processKey ?? opts.sessionId ?? opts.path;
}

/** What a process is spawned with, so a change to any of it means a new process rather than a reuse. */
function spawnKeyOf(opts: ClaudeSessionOpts): string {
    return JSON.stringify([
        sessionKeyOf(opts),
        opts.path,
        opts.claudeArgs ?? [],
        opts.claudeEnvVarsGeneration,
    ]);
}

/**
 * Runs one turn of a Claude session.
 *
 * The session owns the process and the loops that serve it; this door stays as narrow as it was, so
 * the launcher keeps its shape while the process behind it outlives the turn.
 */
export async function claudeRemote(opts: ClaudeSessionOpts): Promise<void> {
    const key = sessionKeyOf(opts);
    const spawnKey = spawnKeyOf(opts);
    let entry = liveSessions.get(key);
    logger.debug(`[claudeRemote] turn for ${key}: live=${entry ? `yes(alive=${entry.session.isAlive()})` : 'no'} liveCount=${liveSessions.size}`);
    if (entry && entry.spawnKey !== spawnKey) {
        // Spawned differently than this turn needs — a profile applied, say. The session's own
        // re-spawn path hands the message back for exactly this, and the process it was running
        // has to go, or it keeps the conversation open beside its replacement.
        logger.debug('[claudeRemote] the live process no longer matches what this turn needs, letting it go');
        entry.session.end();
        liveSessions.delete(key);
        entry = undefined;
    }
    if (entry && !entry.session.acceptsTurn(opts)) {
        logger.debug('[claudeRemote] letting the live session go and starting another');
        // Either it is busy (the launcher serves one turn at a time, so this would be a bug worth
        // not building on) or it holds a different conversation (the session was reset).
        entry.session.end();
        liveSessions.delete(key);
        entry = undefined;
    }
    if (!entry) {
        logger.debug('[claudeRemote] starting a session process');
        entry = { session: new ClaudeSession(opts), spawnKey };
        liveSessions.set(key, entry);
    }
    const serving = entry.session;
    await serving.runTurn(opts);
    if (!serving.isAlive()) {
        liveSessions.delete(key);
    }
}

/** Lets every live process go. Called when the CLI stops serving the sessions that own them. */
export function endClaudeSessions(): void {
    for (const { session } of liveSessions.values()) {
        session.end();
    }
    liveSessions.clear();
}
