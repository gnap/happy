/**
 * Reading a `SendMessage` tool call — the tool a session uses to talk to another of the user's
 * sessions.
 *
 * Everything here is about picking the *human* part out of a call whose payload is a message
 * addressed to a machine: which line names it, who it is for, and what was actually said. The tool
 * carries the first two in more than one place depending on who filled them in — Claude Code names
 * the message with `display` and also summarises it with `summary`, and a recipient is `to` in the
 * input — so the order below is the order of preference, not a guess at one shape.
 *
 * Pure and separate from the views so the awkward part (which field wins) can be tested without
 * rendering a card.
 */

/** What either end of a tool call looks like, as far as this file cares. */
export type MessageToolCall = {
    input?: unknown;
    result?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const asText = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/** The first of `keys` that holds text, in the object or — for `display` — in the result too. */
const pick = (sources: (Record<string, unknown> | null)[], keys: string[]): string | null => {
    for (const key of keys) {
        for (const source of sources) {
            const text = asText(source?.[key]);
            if (text !== null) {
                return text;
            }
        }
    }
    return null;
};

/**
 * What the message is called: the name Claude Code gave it, its summary, or failing both the
 * recipient — the tool is never nameless, because a card that says only "Send Message" tells the
 * reader nothing about which of their sessions is being talked to.
 */
export function sendMessageTitle(tool: MessageToolCall): string | null {
    return pick([asRecord(tool.input), asRecord(tool.result)], ['display', 'summary', 'to']);
}

/** Who the message is for. */
export function sendMessageRecipient(tool: MessageToolCall): string | null {
    return pick([asRecord(tool.input)], ['to']);
}

/** What was said, as written. */
export function sendMessageBody(tool: MessageToolCall): string | null {
    return pick([asRecord(tool.input)], ['message']);
}

/** How the send ended, for a card that has to say so in a word. */
export function sendMessageOutcome(state: 'running' | 'completed' | 'error'): 'sending' | 'sent' | 'failed' {
    if (state === 'error') {
        return 'failed';
    }
    return state === 'completed' ? 'sent' : 'sending';
}

/**
 * The reason a send failed, from whatever the tool result turned out to be.
 *
 * A failed tool result reaches the App as a string or as a structure, and this is only ever used to
 * put one line under a card, so anything nested is handed back as it stands rather than flattened.
 */
export function sendMessageFailure(result: unknown): string | null {
    const text = asText(result);
    if (text !== null) {
        return text;
    }
    return pick([asRecord(result)], ['error', 'message', 'display']);
}
