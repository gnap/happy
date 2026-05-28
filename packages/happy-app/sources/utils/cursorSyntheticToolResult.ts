/** CLI synthetic tool-call-end payloads (see happy-cli cursorSessionNotices.ts). */
export function isCursorSyntheticToolResult(content: unknown): boolean {
    if (content === null || content === undefined) {
        return false;
    }
    const text = typeof content === 'string' ? content.trim() : JSON.stringify(content);
    if (!text) {
        return false;
    }
    if (text.includes('"turnEnded":true') && text.includes('Turn completed; tool did not report end')) {
        return true;
    }
    if (text.includes('"aborted":true') && text.includes('Tool call ended without result')) {
        return true;
    }
    if (text.includes('"runningInBackground":true')) {
        return true;
    }
    return false;
}
