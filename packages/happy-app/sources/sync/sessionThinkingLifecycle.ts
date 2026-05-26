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
        ev?: SessionEv;
    };
}): SessionEv | null {
    const contentType = rawContent.content?.type;
    if (contentType !== 'session') {
        return null;
    }
    return rawContent.content?.data?.ev ?? rawContent.content?.ev ?? null;
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

function readSessionLifecycleContext(rawContent: unknown): {
    contentType?: string;
    dataType?: string;
    lifecycleEv: SessionEv | null;
    sessionEventType?: string;
} {
    if (!rawContent || typeof rawContent !== 'object') {
        return { lifecycleEv: null };
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

    const lifecycleEv = readNestedLifecycleEvent(content) ?? readFlatSessionEnvelopeEvent(content);
    return {
        contentType: content.content?.type,
        dataType: content.content?.data?.type,
        lifecycleEv,
        sessionEventType:
            lifecycleEv?.t ??
            content.content?.data?.ev?.t ??
            content.content?.ev?.t,
    };
}

/** True when durable message is a session-protocol turn-start (used for ephemeral grace window). */
export function isSessionTurnStartMessageContent(rawContent: unknown): boolean {
    return readSessionLifecycleContext(rawContent).sessionEventType === 'turn-start';
}

export function getSessionThinkingPatchFromMessageContent(
    rawContent: unknown,
): { thinking: boolean } | null {
    const { contentType, dataType, lifecycleEv, sessionEventType } = readSessionLifecycleContext(rawContent);
    if (!contentType && !dataType && !sessionEventType) {
        return null;
    }

    const isTaskComplete =
        ((contentType === 'acp' || contentType === 'codex') &&
            (dataType === 'task_complete' || dataType === 'turn_aborted')) ||
        sessionEventType === 'turn-end';

    const isTaskStarted =
        ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started') ||
        sessionEventType === 'turn-start' ||
        sessionEventType === 'tool-call-start' ||
        isSummarizingServiceEvent(lifecycleEv);

    if (isTaskComplete) {
        return { thinking: false };
    }
    if (isTaskStarted) {
        return { thinking: true };
    }
    return null;
}
