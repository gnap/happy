import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/lib';
import { getProjectPath } from './path';
import { RawJSONLines, RawJSONLinesSchema } from '@/claude/types';

type ApiMessage = { role: 'user' | 'assistant'; content: any };

/** Parse a session JSONL file into API-compatible message array. */
async function readMessagesFromSession(projectDir: string, sessionId: string): Promise<ApiMessage[]> {
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    let file: string;
    try {
        file = await readFile(sessionFile, 'utf-8');
    } catch {
        return [];
    }

    const messages: ApiMessage[] = [];
    for (const line of file.split('\n')) {
        if (!line.trim()) continue;
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; }
        const parsed = RawJSONLinesSchema.safeParse(obj);
        if (!parsed.success) continue;
        const m: RawJSONLines = parsed.data;

        if (m.type === 'summary') {
            messages.push({ role: 'user', content: m.summary });
        } else if (m.type === 'user' && !(m as any).isSidechain && !(m as any).isMeta) {
            const content = (m as any).message?.content;
            if (content !== undefined && content !== null) {
                messages.push({ role: 'user', content });
            }
        } else if (m.type === 'assistant') {
            const content = (m as any).message?.content;
            if (content) {
                messages.push({ role: 'assistant', content });
            }
        }
    }
    return messages;
}

/**
 * Count tokens for a session by reading its JSONL and calling the Anthropic
 * countTokens API via plain fetch. No additional SDK dependency required.
 *
 * Expects ANTHROPIC_AUTH_TOKEN (and optionally ANTHROPIC_BASE_URL) to be set
 * in process.env — claudeRemote.ts writes claudeEnvVars before this is called.
 *
 * Returns:
 *   number  — token count (success)
 *   null    — transient failure or no messages; caller may retry next turn
 *   false   — permanent failure (4xx other than 429, unsupported endpoint);
 *             caller should stop retrying for this session
 */
export async function countTokensForSession(opts: {
    sessionId: string;
    workspacePath: string;
    /** Model string, may include [1m] suffix — stripped internally. */
    model: string;
}): Promise<number | null | false> {
    // ANTHROPIC_AUTH_TOKEN → Bearer (OAuth / claude.ai tokens)
    // ANTHROPIC_API_KEY   → x-api-key (standard API key)
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!authToken && !apiKey) {
        logger.debug('[countTokens] No auth credentials, skipping');
        return null;
    }

    const projectDir = getProjectPath(opts.workspacePath);
    const messages = await readMessagesFromSession(projectDir, opts.sessionId);
    if (messages.length === 0) {
        logger.debug(`[countTokens] No messages in session ${opts.sessionId}`);
        return null;
    }

    const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const model = opts.model.replace(/\[1m\]/gi, '');
    const authHeaders: Record<string, string> = authToken
        ? { 'Authorization': `Bearer ${authToken}` }
        : { 'x-api-key': apiKey! };

    try {
        const res = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'token-counting-2024-11-01',
            },
            body: JSON.stringify({ model, messages }),
        });
        if (!res.ok) {
            // 4xx (except 429 rate-limit) = permanent: endpoint unsupported or auth
            // rejected. Signal caller to stop retrying for this session.
            const permanent = res.status !== 429 && res.status >= 400 && res.status < 500;
            logger.debug(`[countTokens] API error ${res.status} for session ${opts.sessionId}${permanent ? ' (permanent)' : ''}`);
            return permanent ? false : null;
        }
        const data = await res.json() as { input_tokens?: number };
        const tokenCount = data.input_tokens ?? null;
        logger.debug(`[countTokens] ${tokenCount} tokens for session ${opts.sessionId}`);
        return tokenCount;
    } catch (err) {
        logger.debug(`[countTokens] fetch failed for session ${opts.sessionId}:`, err);
        return null;
    }
}
