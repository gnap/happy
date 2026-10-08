import axios from 'axios';
import { configuration, serverHttpsAgent } from '@/configuration';
import { decrypt, decodeBase64 } from '@/api/encryption';
import { readCredentials } from '@/persistence';
import { readDaemonSessionKey } from './sendA2aMessage';
import { logger } from '@/ui/logger';

/**
 * Result returned to the spawn path. environmentVariables is the resolved env
 * map the App sent on the matching user message; profileId identifies which
 * profile it came from. Both are null when no recoverable profile is found.
 */
export interface SessionProfileMeta {
    profileId: string | null;
    environmentVariables: Record<string, string> | null;
}

type RawMessage = {
    id: string;
    seq: number;
    content: { t: string; c?: string } | null;
    createdAt: number;
};

/**
 * Hard ceiling on the whole lookup, enforced by the caller racing this against a timer and
 * by the request's own abort signal.
 *
 * This runs on the critical path of a user-initiated restart, and its result is only a
 * best-effort recovery of the App's profile: a null answer is already handled by spawning
 * with the daemon's baseline env. So there is nothing to gain by waiting, and a lot to lose —
 * on a stalled server the request can outlive the axios `timeout`, which does not cover DNS
 * resolution or connection setup, and a restart that never returns has no cure short of
 * restarting the daemon.
 */
export const PROFILE_META_DEADLINE_MS = 5_000;

/**
 * Walk the most-recent messages of `sessionId` (server returns newest first),
 * decrypt with the daemon-held session key, and return the latest user message's
 * `meta.profileId` + `meta.environmentVariables`. Used by restart-session so the
 * respawned process can apply the same profile env as the live App, instead of
 * starting bare and only learning the profile from the first new user message.
 */
export async function fetchSessionProfileMeta(sessionId: string): Promise<SessionProfileMeta | null> {
    const credentials = await readCredentials();
    if (!credentials) {
        logger.debug('[DAEMON RUN] fetchSessionProfileMeta: no credentials');
        return null;
    }
    const sessionKey = await readDaemonSessionKey(sessionId);
    if (!sessionKey) {
        logger.debug(`[DAEMON RUN] fetchSessionProfileMeta: no session key for ${sessionId}`);
        return null;
    }

    let response;
    try {
        response = await axios.get<{ messages: RawMessage[] }>(
            `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
            {
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                },
                httpsAgent: serverHttpsAgent,
                timeout: 30000,
                signal: AbortSignal.timeout(PROFILE_META_DEADLINE_MS),
            },
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`[DAEMON RUN] fetchSessionProfileMeta: GET messages failed for ${sessionId}: ${message}`);
        return null;
    }

    const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
    // Server returns newest first (createdAt desc); walk in order.
    for (const message of messages) {
        if (message.content?.t !== 'encrypted' || !message.content.c) continue;
        let body: unknown;
        try {
            body = decrypt(sessionKey, credentials.encryption.type, decodeBase64(message.content.c));
        } catch {
            continue;
        }
        if (!body || typeof body !== 'object') continue;
        const meta = (body as { meta?: unknown }).meta;
        if (!meta || typeof meta !== 'object') continue;
        if (!Object.prototype.hasOwnProperty.call(meta, 'profileId')) continue;
        const profileId = (meta as { profileId?: string | null }).profileId ?? null;
        const envVars = (meta as { environmentVariables?: Record<string, string> }).environmentVariables;
        const environmentVariables = envVars && Object.keys(envVars).length > 0 ? envVars : null;
        logger.debug(
            `[DAEMON RUN] fetchSessionProfileMeta: recovered profileId=${profileId ?? 'null'} `
            + `envKeys=${environmentVariables ? Object.keys(environmentVariables).join(',') : '(none)'} `
            + `from message seq=${message.seq}`,
        );
        return { profileId, environmentVariables };
    }
    logger.debug(`[DAEMON RUN] fetchSessionProfileMeta: no message with profileId meta in ${messages.length} recent message(s)`);
    return null;
}
