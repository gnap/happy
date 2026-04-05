import type { Message } from './typesMessage';

/**
 * Join two streamed assistant fragments without turning every token into its own paragraph.
 * (Inserting `\n\n` between chunks breaks token-level streaming: "The" + "quick" becomes two blocks.)
 *
 * - Respect newlines already present in the stream.
 * - If either side already has whitespace at the join, do nothing extra.
 * - If ASCII letters/digits would run together, insert a single space (word boundary).
 * - If sentence punctuation meets a following letter, insert a space ("Done." + "Next").
 * - Otherwise concatenate (markdown punctuation, CJK, URLs, etc.).
 */
function joinAssistantTextChunks(prev: string, next: string): string {
    if (!prev) {
        return next;
    }
    if (!next) {
        return prev;
    }
    if (prev.endsWith('\n') || next.startsWith('\n')) {
        return prev + next;
    }
    if (/\s$/.test(prev) || /^\s/.test(next)) {
        return prev + next;
    }

    const prevLast = prev[prev.length - 1] ?? '';
    const nextFirst = next[0] ?? '';
    const wouldGlueWords =
        /[a-zA-Z0-9]/.test(prevLast) && /[a-zA-Z0-9]/.test(nextFirst);
    if (wouldGlueWords) {
        return `${prev} ${next}`;
    }
    if (/[.!?…]/.test(prevLast) && /[a-zA-Z0-9]/.test(nextFirst)) {
        return `${prev} ${next}`;
    }

    return prev + next;
}

/**
 * Cursor / session-protocol streaming often persists assistant output as multiple
 * messages in one turn. The chat UI renders each as a separate row with vertical
 * margin, which reads as extra paragraph breaks. Merge only consecutive agent-text
 * rows (chronological, with nothing else between).
 */
export function mergeAdjacentAgentTextMessages(messages: Message[]): Message[] {
    if (messages.length <= 1) {
        return messages;
    }

    const asc = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    const out: Message[] = [];

    for (const msg of asc) {
        const prev = out[out.length - 1];
        if (
            msg.kind === 'agent-text' &&
            !msg.isThinking &&
            prev?.kind === 'agent-text' &&
            !prev.isThinking
        ) {
            out[out.length - 1] = {
                ...prev,
                text: joinAssistantTextChunks(prev.text, msg.text),
                createdAt: Math.max(prev.createdAt, msg.createdAt),
            };
        } else {
            out.push(msg);
        }
    }

    return out.sort((a, b) => b.createdAt - a.createdAt);
}
