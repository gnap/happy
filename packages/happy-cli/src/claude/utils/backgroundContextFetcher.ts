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
import { normalizeClaudeModelForSdk } from '@/claude/utils/model';
import { logger } from '@/ui/logger';

const DEFAULT_INTERVAL_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;

const INHERITED_ENV_PREFIXES = ['ANTHROPIC_', 'DEEPSEEK_', 'CLAUDE_CODE_', 'CLAUDE_', 'HAPPY_', 'HOME', 'PATH'];

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

/**
 * Spawn a `claude --resume <session> --print "/context"` and parse the result.
 * Returns parsed context usage or null on failure.
 */
async function spawnContextFetch(opts: {
    claudeSessionId: string;
    projectPath: string;
    envVars: Record<string, string>;
    signal?: AbortSignal;
    /** If set, passed as --model flag (same mechanism as the main agent). */
    model?: string;
}): Promise<ParsedContextUsage | null> {
    const env: Record<string, string | undefined> = {
        ...process.env,
        ...collectEnvByPrefix(INHERITED_ENV_PREFIXES),
        ...opts.envVars,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    };

    const args = [
        '--print', '/context',
        '--output-format', 'stream-json',
        '--verbose',
        '--resume', opts.claudeSessionId,
        '--max-turns', '2',
        '--permission-mode', 'bypassPermissions',
    ];
    // Mirror the main agent: pass --model flag so it takes priority over any
    // ANTHROPIC_MODEL env var the profile may have set to a different model.
    if (opts.model) {
        args.push('--model', opts.model);
    }

    const child = spawn('claude', args, {
        cwd: opts.projectPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: COMMAND_TIMEOUT_MS,
    });

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
 * Returns an object with:
 * - dispose: stops the timer
 * - poke:    call after a successful turn to trigger a fetch within 1 s
 *            (respects the minimum interval between fetches).
 */
export function startBackgroundContextFetcher(opts: {
    session: ApiSessionClient;
    /** Dynamic getter — the Claude session ID can change during forks. */
    getClaudeSessionId: () => string | null;
    projectPath: string;
    /** Dynamic getter — returns the current profile env vars so profile switches are reflected. */
    getEnvVars?: () => Record<string, string>;
    intervalMs?: number;
    /**
     * Dynamic getter — returns the per-message model override (e.g. from message meta.model).
     * When undefined, falls back to session metadata's currentModelCode so the first tick
     * after a restart uses the last persisted model rather than the profile's ANTHROPIC_MODEL.
     */
    getModel?: () => string | undefined;
}): { dispose: () => void; poke: () => void } {
    const minIntervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    let pokeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFetchTime = 0;

    const resolveModel = (): string | undefined => {
        const explicit = opts.getModel?.();
        if (explicit) return explicit;
        const fromMeta = normalizeClaudeModelForSdk(opts.session.getMetadata()?.currentModelCode);
        return fromMeta;
    };

    const tick = async () => {
        const claudeSessionId = opts.getClaudeSessionId();
        if (!claudeSessionId) return;
        const usage = await spawnContextFetch({
            claudeSessionId,
            projectPath: opts.projectPath,
            envVars: opts.getEnvVars?.() ?? {},
            model: resolveModel(),
        });
        if (!usage) return;
        lastFetchTime = Date.now();

        try {
            await opts.session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                contextUsage: {
                    currentTokens: usage.currentTokens,
                    maxTokens: usage.maxTokens,
                    pct: Math.round((usage.currentTokens / usage.maxTokens) * 100),
                    model: usage.model,
                    breakdown: usage.breakdown,
                    fetchedAt: lastFetchTime,
                },
            }));
            logger.debug(
                `[contextFetch] updated metadata: ${usage.currentTokens} / ${usage.maxTokens} (${Math.round((usage.currentTokens / usage.maxTokens) * 100)}%)`,
            );
        } catch (err) {
            logger.debug('[contextFetch] metadata update failed:', err);
        }
    };

    const poke = () => {
        // Honour minimum interval between fetches.
        const elapsed = Date.now() - lastFetchTime;
        if (elapsed < minIntervalMs) {
            logger.debug(`[contextFetch] poke ignored (last fetch ${Math.round(elapsed / 1000)}s ago, min ${Math.round(minIntervalMs / 1000)}s)`);
            return;
        }
        if (pokeTimer !== null) return; // already scheduled
        pokeTimer = setTimeout(() => {
            pokeTimer = null;
            tick();
        }, 1000);
        logger.debug('[contextFetch] poke scheduled (fetch in 1 s)');
    };

    // Initial fetch after a short delay (startup trigger)
    const initialTimer = setTimeout(() => {
        tick();
    }, 10_000);

    const dispose = () => {
        clearTimeout(initialTimer);
        if (pokeTimer) clearTimeout(pokeTimer);
    };

    return { dispose, poke };
}
