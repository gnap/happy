import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { A2AInboxMessage } from '@/api/types';

/** Soft cap on text/title bytes returned inline from list_a2a_messages / read_a2a_message. */
const DEFAULT_PREVIEW_MAX_CHARS = 2000;

export function resolveA2AInboxPreviewMaxChars(): number {
    const raw = process.env.HAPPY_A2A_INBOX_PREVIEW_MAX_CHARS;
    if (raw === undefined || raw === '') return DEFAULT_PREVIEW_MAX_CHARS;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PREVIEW_MAX_CHARS;
}

function truncate(value: string | undefined, maxChars: number): { value: string | undefined; truncated: boolean } {
    if (value == null) return { value, truncated: false };
    if (value.length <= maxChars) return { value, truncated: false };
    return { value: value.slice(0, maxChars), truncated: true };
}

export interface A2AInboxMessagePreview {
    id: string;
    title?: string;
    text: string;
    createdAt: number;
    readAt?: number | null;
    /** True when text was sliced to fit preview budget; full body is on disk at bodyFile. */
    textTruncated: boolean;
    /** True when title was sliced. */
    titleTruncated?: boolean;
    /** Absolute path to JSON file containing the full message; read with the agent's file tool. */
    bodyFile: string;
    /** Total characters of original text — lets the agent decide whether to fetch the bodyFile. */
    textLength: number;
}

/** Per-message body dir for one session. */
function bodyDir(workspacePath: string, sessionId: string): string {
    return join(workspacePath, '.happy', 'a2a-inbox', 'messages', sessionId);
}

/**
 * Write the full message body to disk (idempotent per message id) and return a preview record
 * with `text`/`title` truncated to fit the prompt budget. The agent reads bodyFile when needed.
 *
 * Prevents large A2A payloads from bloating the SDK request body on every turn (they're echoed
 * back in tool_result content forever and balloon resume contexts → upstream 500s on big sessions).
 */
export function buildA2AInboxMessagePreview(
    workspacePath: string,
    sessionId: string,
    message: A2AInboxMessage,
    maxChars: number = resolveA2AInboxPreviewMaxChars(),
): A2AInboxMessagePreview {
    const dir = bodyDir(workspacePath, sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const bodyFile = join(dir, `${message.id}.json`);
    writeFileSync(bodyFile, JSON.stringify(message, null, 2));

    const textParts = truncate(message.text, maxChars);
    const titleParts = truncate(message.title, Math.min(maxChars, 400));
    return {
        id: message.id,
        title: titleParts.value,
        text: textParts.value ?? '',
        createdAt: message.createdAt,
        readAt: message.readAt ?? null,
        textTruncated: textParts.truncated,
        titleTruncated: titleParts.truncated || undefined,
        bodyFile,
        textLength: message.text?.length ?? 0,
    };
}
