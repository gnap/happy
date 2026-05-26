/**
 * Derive session.thinking updates from durable message payloads (turn-start / turn-end, Codex task_*).
 * Ephemeral session-alive can be dropped (volatile); lifecycle messages must clear stuck thinking in the App.
 */
type SessionEv = { t?: string; text?: string };

function readNestedLifecycleEvent(rawContent: {
    content?: {
        type?: string;
        data?: {
            type?: string;
            ev?: SessionEv;
        };
    };
}): SessionEv | null {
    const contentType = rawContent.content?.type;
    if (contentType !== 'session') {
        return null;
    }
    return rawContent.content?.data?.ev ?? null;
}

/** CLI sendSessionProtocolMessage: { role: 'session', content: SessionEnvelope }. */
function readFlatSessionEnvelopeEvent(rawContent: {
    role?: string;
    content?: SessionEv | { ev?: SessionEv };
}): SessionEv | null {
    if (rawContent.role !== 'session' || !rawContent.content || typeof rawContent.content !== 'object') {
        return null;
    }
    const inner = rawContent.content as SessionEv & { ev?: SessionEv };
    if (inner.ev && typeof inner.ev === 'object') {
        return inner.ev;
    }
    if (typeof inner.t === 'string') {
        return inner;
    }
    return null;
}

function isSummarizingServiceEvent(ev: SessionEv | null): boolean {
    if (!ev || ev.t !== 'service' || typeof ev.text !== 'string') {
        return false;
    }
    return /\b(?:summariz|compress)/i.test(ev.text);
}

export function getSessionThinkingPatchFromMessageContent(
    rawContent: unknown,
): { thinking: boolean } | null {
    if (!rawContent || typeof rawContent !== 'object') {
        return null;
    }

    const content = rawContent as {
        role?: string;
        content?: {
            type?: string;
            data?: {
                type?: string;
                ev?: SessionEv;
            };
            ev?: SessionEv;
            t?: string;
            text?: string;
        };
    };

    const contentType = content.content?.type;
    const dataType = content.content?.data?.type;

    const lifecycleEv = readNestedLifecycleEvent(content) ?? readFlatSessionEnvelopeEvent(content);
    const sessionEventType = lifecycleEv?.t;

    const isTaskComplete =
        ((contentType === 'acp' || contentType === 'codex' || contentType === 'cursor') &&
            (dataType === 'task_complete' || dataType === 'turn_aborted')) ||
        sessionEventType === 'turn-end';

    const isTaskStarted =
        ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started') ||
        sessionEventType === 'turn-start' ||
        isSummarizingServiceEvent(lifecycleEv);

    if (isTaskComplete) {
        return { thinking: false };
    }
    if (isTaskStarted) {
        return { thinking: true };
    }
    return null;
}
