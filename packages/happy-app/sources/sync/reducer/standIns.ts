/**
 * Which permission stand-ins belong in the visible window.
 *
 * The reducer creates a tool message for every permission `agentState` lists whose tool call the
 * batch it was handed does not contain — that is how a question stays answerable while the
 * message log is unreachable, and how a decision recorded in `agentState.completedRequests`
 * survives a cold start with no cached window. The consequence is that a session whose cache was
 * cleared gets one stand-in per completed request: they carry the permission's own `createdAt`,
 * which is older than every message in the freshly loaded window, so they sort above the loaded
 * history as a detached block of cards.
 *
 * A finished stand-in like that describes a tool call that is further back than anything loaded.
 * Its real message is in the log, not lost; keeping the stand-in on screen only adds a card whose
 * context has not been paged in. It stays in the reducer state (so the real tool call can adopt it
 * when that history arrives) and is left out of the visible projection until then. A pending
 * stand-in is the question itself and is never dropped.
 */

import { Message } from '@/sync/typesMessage';

/** A stand-in created from `agentState`, not from the message log. */
export function isPermissionStandIn(message: Message): boolean {
    if (message.kind !== 'tool-call') {
        return false;
    }
    // A real tool call is adopted by its message and gets `startedAt`; a stand-in never does
    // until that message is replayed. Pending stand-ins are `running` and must stay visible.
    return message.tool.startedAt === null && message.tool.state !== 'running';
}

/** Removes finished stand-ins that describe a tool call older than everything loaded. */
export function dropStandInsOutsideWindow(messages: Message[]): Message[] {
    let oldestReal: number | null = null;
    for (const message of messages) {
        if (!isPermissionStandIn(message) && (oldestReal === null || message.createdAt < oldestReal)) {
            oldestReal = message.createdAt;
        }
    }
    if (oldestReal === null) {
        return messages;
    }
    return messages.filter(message => !isPermissionStandIn(message) || message.createdAt >= oldestReal);
}

/** The visible window and its map, both without out-of-window stand-ins. */
export function visibleWindow(messages: Message[]): { messages: Message[]; messagesMap: Record<string, Message> } {
    const visible = dropStandInsOutsideWindow(messages);
    const messagesMap: Record<string, Message> = {};
    for (const message of visible) {
        messagesMap[message.id] = message;
    }
    return { messages: visible, messagesMap };
}
