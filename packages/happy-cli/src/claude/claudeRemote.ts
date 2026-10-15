import { ClaudeSession, type ClaudeSessionOpts } from './claudeSession';

// Reached for by name from the tool tests and from the launcher.
export {
    ClaudeSession,
    normalizeTaskType,
    taskTypeOf,
    mergeTask,
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
const liveSessions = new Map<string, ClaudeSession>();

/** What a process is spawned with, so a change to any of it means a new process rather than a reuse. */
function spawnKeyOf(opts: ClaudeSessionOpts): string {
    return JSON.stringify([
        opts.processKey ?? opts.sessionId ?? opts.path,
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
    const key = spawnKeyOf(opts);
    let session = liveSessions.get(key);
    if (session && !session.acceptsTurn(opts)) {
        // Either it is busy (the launcher serves one turn at a time, so this would be a bug worth
        // not building on) or it holds a different conversation (the session was reset).
        session.end();
        liveSessions.delete(key);
        session = undefined;
    }
    if (!session) {
        session = new ClaudeSession(opts);
        liveSessions.set(key, session);
    }
    const serving = session;
    await serving.runTurn(opts);
    if (!serving.isAlive()) {
        liveSessions.delete(key);
    }
}

/** Lets every live process go. Called when the CLI stops serving the sessions that own them. */
export function endClaudeSessions(): void {
    for (const session of liveSessions.values()) {
        session.end();
    }
    liveSessions.clear();
}
