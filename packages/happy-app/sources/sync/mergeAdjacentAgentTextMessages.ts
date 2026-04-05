import type { Message } from './typesMessage';

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
    const needsSpace = /[a-zA-Z0-9]$/.test(prev) && /^[a-zA-Z0-9]/.test(next);
    return needsSpace ? `${prev} ${next}` : prev + next;
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
            // Do not insert `\n\n` here: that splits parseMarkdown into multiple
            // paragraph blocks, each with block margins — looks like extra blank lines.
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
