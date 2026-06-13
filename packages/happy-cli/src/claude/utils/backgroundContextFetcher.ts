/**
 * Background /context fetch: spawns a lightweight Claude child process
 * (--resume, --print "/context") on a timer, parses the real context usage
 * from Claude's internal counter, and writes the result to session metadata.
 *
 * This runs OUTSIDE the conversation loop — no invasive changes to the
 * launcher or claudeRemote turn lifecycle.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { ApiSessionClient } from '@/api/apiSession';
import { parseContextUsageOutput, type ParsedContextUsage } from './parseContextUsage';
import { logger } from '@/ui/logger';

const DEFAULT_INTERVAL_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Collect the current process env keys that start with any of the given
 * prefixes. Merged on top of the caller-supplied envVars so the child
 * inherits the same API keys, proxy settings, etc.
 */
function collectEnvByPrefix(prefixes: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!value) continue;
        for (const prefix of prefixes) {
            if (key.startsWith(prefix)) {
                result[key] = value;
                break;
            }
        }
    }
    return result;
}

const INHERITED_ENV_PREFIXES = ['ANTHROPIC_', 'DEEPSEEK_', 'CLAUDE_CODE_', 'CLAUDE_', 'HAPPY_', 'HOME', 'PATH'];

/**
 * Spawn a `claude --resume <session> --print "/context"` and parse the result.
 * Returns parsed context usage or null on failure.
 */
async function spawnContextFetch(opts: {
    claudeSessionId: string;
    projectPath: string;
    envVars: Record<string, string>;
    signal?: AbortSignal;
}): Promise<ParsedContextUsage | null> {
    const env = {
        ...process.env,
        ...collectEnvByPrefix(INHERITED_ENV_PREFIXES),
        ...opts.envVars,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    };

    const child = spawn(
        'claude',
        [
            '--print', '/context',
            '--output-format', 'stream-json',
            '--verbose',
            '--resume', opts.claudeSessionId,
            '--max-turns', '2',
            '--permission-mode', 'bypassPermissions',
        ],
        {
            cwd: opts.projectPath,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: COMMAND_TIMEOUT_MS,
        },
    );

    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });

    try {
        const [exitCode] = (await once(child, 'close')) as [number | null, number | null];
        if (exitCode !== 0) {
            logger.debug(`[contextFetch] child exited with code ${exitCode}`);
            return null;
        }

        // Parse the last result message
        const lines = stdout.split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const msg = JSON.parse(lines[i]);
                if (msg.type === 'result' && typeof msg.result === 'string') {
                    return parseContextUsageOutput(msg.result);
                }
            } catch { /* skip malformed JSON */ }
        }
        return null;
    } catch (err) {
        if (!opts.signal?.aborted) {
            logger.debug('[contextFetch] spawn error:', err);
        }
        return null;
    }
}

/**
 * Start a periodic background timer that fetches /context from Claude.
 * The result is written to session metadata via `session.updateMetadata`.
 *
 * Returns a dispose function that stops the timer.
 */
export function startBackgroundContextFetcher(opts: {
    session: ApiSessionClient;
    /** Dynamic getter — the Claude session ID can change during forks. */
    getClaudeSessionId: () => string | null;
    projectPath: string;
    envVars?: Record<string, string>;
    intervalMs?: number;
}): () => void {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const envVars = opts.envVars ?? {};
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
        const claudeSessionId = opts.getClaudeSessionId();
        if (!claudeSessionId) return;
        const usage = await spawnContextFetch({
            claudeSessionId,
            projectPath: opts.projectPath,
            envVars,
        });
        if (!usage) return;

        const snapshot = {
            currentTokens: usage.currentTokens,
            maxTokens: usage.maxTokens,
            pct: Math.round((usage.currentTokens / usage.maxTokens) * 100),
            model: usage.model,
            breakdown: usage.breakdown,
            fetchedAt: Date.now(),
        };
        (opts.session as any)._lastContextUsage = snapshot;
        logger.debug(
            `[contextFetch] snapshot: ${usage.currentTokens} / ${usage.maxTokens} (${Math.round((usage.currentTokens / usage.maxTokens) * 100)}%)`,
        );

    };

    // First fetch after a short delay (give the session time to initialise)
    const initialTimer = setTimeout(() => {
        tick();
        timer = setInterval(tick, intervalMs);
    }, 10_000);

    return () => {
        clearTimeout(initialTimer);
        if (timer) clearInterval(timer);
    };
}
