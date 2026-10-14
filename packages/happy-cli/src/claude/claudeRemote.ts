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
 * Runs one turn of a Claude session.
 *
 * The session owns the SDK process and the loops that serve it; this door stays as narrow as it was
 * so the launcher keeps its shape while the process behind it is free to outlive a turn.
 */
export async function claudeRemote(opts: ClaudeSessionOpts): Promise<void> {
    return new ClaudeSession(opts).run();
}
