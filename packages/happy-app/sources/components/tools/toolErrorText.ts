/**
 * Turning a tool result into one line of failure text.
 *
 * A result does not always arrive as a string. Permission answers, MCP tools and some provider
 * errors arrive as structures, and a structure that reaches `String()` produces "[object Object]"
 * — a card that says nothing about what happened. This reads the human sentence out of whichever
 * shape arrived and, when there is no such sentence, shows the structure itself rather than
 * dropping it.
 */
export function toolErrorMessage(result: unknown): string | null {
    if (result === null || result === undefined) {
        return null;
    }
    if (typeof result === 'string') {
        return result.trim().length > 0 ? result : null;
    }
    if (typeof result === 'number' || typeof result === 'boolean') {
        return String(result);
    }
    if (typeof result !== 'object') {
        return String(result);
    }
    const record = result as Record<string, unknown>;
    for (const key of ['error', 'message', 'reason']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    try {
        const json = JSON.stringify(result, null, 2);
        return json && json !== '{}' ? json : null;
    } catch {
        return null;
    }
}
