import type { Message } from './typesMessage';

/**
 * Cursor / session-protocol streaming often persists assistant output as multiple
 * messages in one turn. The chat UI renders each as a separate row with vertical
 * margin, which reads as extra paragraph breaks. Merge only consecutive agent-text
 * rows (chronological, with nothing else between).
 *
 * Between chunks we insert `\n\n` when neither side already has a newline at the
 * join, so the model's logical line breaks survive parsing (blank line → paragraph
 * in parseMarkdown). Chunk pairs that already abut with `\n` are not given an
 * extra blank line. MarkdownView uses tighter margins between adjacent text blocks
 * so this does not look like huge gaps.
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
            const gap =
                prev.text.endsWith('\n') || msg.text.startsWith('\n') ? '' : '\n\n';
            out[out.length - 1] = {
                ...prev,
                text: prev.text + gap + msg.text,
                createdAt: Math.max(prev.createdAt, msg.createdAt),
            };
        } else {
            out.push(msg);
        }
    }

    return out.sort((a, b) => b.createdAt - a.createdAt);
}
