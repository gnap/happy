/**
 * Offline Session Stub
 *
 * A no-op `ApiSessionClient`-shaped object used when the CLI wrapper loses
 * (or has not yet established) its WebSocket connection to the Happy server.
 * All side-effecting methods become silent no-ops so the rest of the runner
 * code doesn't need to guard every call site.
 *
 * Lifecycle:
 *   1. `setupOfflineReconnection` creates the stub when `api.getOrCreateSession`
 *      returns null (server unreachable at startup).
 *   2. A background task retries the connection; on success it calls
 *      `onSessionSwap(realSession)` in the runner, which replaces the stub.
 *
 * Note on the cast: `ApiSessionClient` is a concrete class with private
 * members. TypeScript's structural check for class types requires those
 * private members to be present, so we cannot avoid `as unknown as
 * ApiSessionClient` without either extending `ApiSessionClient` (heavyweight)
 * or extracting a shared interface (large refactor). The cast is intentional
 * and safe because all public methods are explicitly implemented below.
 */

import { EventEmitter } from 'node:events';
import type { ApiSessionClient, ACPMessageData, ACPProvider, OutputFormatData } from '@/api/apiSession';
import type { AgentState, A2AInboxMessage, A2AInboxState, Metadata } from '@/api/types';
import type { SessionEnvelope } from '@slopus/happy-wire';
import type { RawJSONLines } from '@/claude/types';

class OfflineSessionStub extends EventEmitter {
    readonly sessionId: string;
    readonly sessionEncryptionKey: Uint8Array = new Uint8Array(0);
    readonly rpcHandlerManager = { registerHandler: () => {} };

    constructor(sessionTag: string) {
        super();
        this.sessionId = `offline-${sessionTag}`;
    }

    // ── Outbound messages (no-op while offline) ──────────────────────────────

    sendCodexMessage(_body: unknown): void {}
    sendCursorMessage(_body: unknown): void {}
    sendOutputFormatMessage(_data: OutputFormatData): void {}
    sendAgentMessage(_provider: ACPProvider, _body: ACPMessageData): void {}
    sendClaudeSessionMessage(_body: RawJSONLines): void {}
    sendSessionProtocolMessage(_envelope: SessionEnvelope): void {}
    sendSessionLifecycleEnvelope(_envelope: SessionEnvelope): void {}
    sendSessionEvent(_event: unknown, _id?: string): void {}
    sendSessionDeath(): void {}
    keepAlive(_thinking: boolean, _mode: 'local' | 'remote'): void {}
    sendUsageData(_usage: unknown, _model?: string): void {}
    sendCursorQuotaReport(_payload: unknown): void {}
    closeClaudeSessionTurn(_status?: unknown): void {}

    // ── Lazy tool content (pass-through while offline) ────────────────────────

    maybeLazyEncodeResult(_toolName: string, _callId: string, output: unknown): unknown {
        return output;
    }

    // ── Metadata / state (ignored while offline) ─────────────────────────────

    getMetadata(): Metadata | null { return null; }

    updateMetadata(_handler: (metadata: Metadata) => Metadata): Promise<void> {
        return Promise.resolve();
    }

    getAgentState(): AgentState | null { return null; }

    updateAgentState(_handler: (state: AgentState) => AgentState): void {}

    // ── A2A inbox (empty while offline) ──────────────────────────────────────

    getA2AInbox(): A2AInboxState { return { messages: [] }; }
    recordA2AMessage(_message: A2AInboxMessage): void {}
    markA2AMessageRead(_id: string): void {}
    markA2AMessagesRead(_ids: string[]): void {}

    // ── Incoming message handler ──────────────────────────────────────────────

    onUserMessage(_callback: (data: unknown) => void): void {}

    // ── Connection state ──────────────────────────────────────────────────────

    isSocketConnected(): boolean { return false; }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async flush(): Promise<void> {}
    async close(): Promise<void> {}
}

/**
 * Create a no-op session stub for offline mode.
 *
 * @param sessionTag - The session tag (used to build an offline session ID).
 * @returns An `ApiSessionClient` whose every method is a safe no-op.
 */
export function createOfflineSessionStub(sessionTag: string): ApiSessionClient {
    return new OfflineSessionStub(sessionTag) as unknown as ApiSessionClient;
}
