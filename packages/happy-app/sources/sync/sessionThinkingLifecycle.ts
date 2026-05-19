/**
 * Derive session.thinking updates from durable message payloads (turn-start / turn-end, Codex task_*).
 * Ephemeral session-alive can be dropped (volatile); lifecycle messages must clear stuck thinking in the App.
 */
export function getSessionThinkingPatchFromMessageContent(
    rawContent: unknown,
): { thinking: boolean } | null {
    if (!rawContent || typeof rawContent !== 'object') {
        return null;
    }

    const content = rawContent as {
        content?: {
            type?: string;
            data?: {
                type?: string;
                ev?: { t?: string };
            };
        };
    };

    const contentType = content.content?.type;
    const dataType = content.content?.data?.type;
    const sessionEventType = content.content?.data?.ev?.t;

    const isTaskComplete =
        ((contentType === 'acp' || contentType === 'codex') &&
            (dataType === 'task_complete' || dataType === 'turn_aborted')) ||
        (contentType === 'session' && sessionEventType === 'turn-end');

    const isTaskStarted =
        ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started') ||
        (contentType === 'session' && sessionEventType === 'turn-start');

    if (isTaskComplete) {
        return { thinking: false };
    }
    if (isTaskStarted) {
        return { thinking: true };
    }
    return null;
}
