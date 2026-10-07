/**
 * Offline Session Stub
 *
 * An `ApiSessionClient`-shaped object used when the CLI wrapper loses (or has not yet
 * established) its connection to the Happy server at startup.
 *
 * Outbound messages are NOT dropped: they are encrypted and appended to the same durable
 * outbox a connected session uses, so reconnecting -- which builds a real client for the
 * same tag -- picks them up and delivers them. Everything that requires a live server
 * (metadata/state writes, A2A reconciliation, presence) stays a no-op, because those
 * methods go through `emitWithAck`, which on a socket that never connects would hang
 * rather than fail.
 *
 * Lifecycle:
 *   1. `setupOfflineReconnection` creates the stub when `api.getOrCreateSession`
 *      returns null (server unreachable at startup), handing it the session key so it can
 *      encrypt. That key is persisted before the create attempt, so it exists even though
 *      the create failed.
 *   2. A background task retries; on success it calls `onSessionSwap(realSession)` in the
 *      runner, which replaces the stub. The new client seeds the same outbox file and
 *      drains it over HTTP.
 *
 * Note on the cast: `ApiSessionClient` is a concrete class with private members.
 * TypeScript's structural check for class types requires those private members to be
 * present, so we cannot avoid `as unknown as ApiSessionClient` without either extending
 * `ApiSessionClient` (heavyweight) or extracting a shared interface (large refactor). The
 * cast is intentional and safe because all public methods are explicitly implemented below.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { encodeBase64, encrypt } from '@/api/encryption';
import { loadOutbox, saveOutbox, type OutboxEntry } from '@/api/outboxPersistence';
import { appendSessionLog } from '@/api/sessionLog';
import {
    buildAgentMessagePayload,
    buildCodexPayload,
    buildCursorPayload,
    buildLifecyclePayload,
    buildOutputFormatPayload,
    buildSessionEventPayload,
    buildSessionProtocolPayload,
    stampAgentRecord,
    type SessionEventPayload,
    type SessionRecord,
} from '@/api/sessionPayloads';
import type { ApiSessionClient, ACPMessageData, ACPProvider, OutputFormatData } from '@/api/apiSession';
import type { AgentState, A2AInboxMessage, A2AInboxState, Metadata } from '@/api/types';
import type { SessionEnvelope } from '@slopus/happy-wire';
import type { RawJSONLines } from '@/claude/types';

export type OfflineSessionStubOptions = {
    /** Client-owned session identity. The outbox is keyed by it, so the reconnected client finds these messages. */
    tag: string;
    /** Writer identity, stamped onto envelopes as `site`. */
    site?: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
};

class OfflineSessionStub extends EventEmitter {
    readonly sessionId: string;
    readonly sessionEncryptionKey: Uint8Array;
    readonly rpcHandlerManager = { registerHandler: () => {} };

    private readonly tag: string;
    private readonly site: string | undefined;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    /** Mirrors the persisted queue so each append does not re-read the file. */
    private readonly queued: OutboxEntry[];
    /** Next value of the per-writer envelope counter; seeded from disk, see `queueRecord`. */
    private nextN: number;

    constructor(opts: OfflineSessionStubOptions) {
        super();
        this.sessionId = `offline-${opts.tag}`;
        this.tag = opts.tag;
        this.site = opts.site;
        this.sessionEncryptionKey = opts.encryptionKey;
        this.encryptionVariant = opts.encryptionVariant;
        const restored = loadOutbox(opts.tag);
        this.queued = restored.entries;
        // Continue the counter rather than restarting it: the reconnected client reads this
        // same file, so the two must agree on what comes next.
        this.nextN = restored.site !== undefined && restored.site !== opts.site ? 0 : restored.nextN;
    }

    /**
     * Encrypt and queue a record exactly as a connected client would, so the file this
     * leaves behind is indistinguishable from one built online. `localId` is stored with
     * it, so a later resend is deduped by the server rather than duplicated.
     */
    private queueRecord(record: unknown, localId: string): void {
        const encrypted = encodeBase64(encrypt(this.sessionEncryptionKey, this.encryptionVariant, record));
        this.queued.push({ localId, content: encrypted });
        // Same ciphertext string as the outbox entry, so the log and the queue agree on bytes.
        appendSessionLog(this.tag, this.site, {
            id: localId,
            localId,
            dir: 'out',
            at: Date.now(),
            c: encrypted,
        });
        saveOutbox(this.tag, { entries: this.queued, nextN: this.nextN, site: this.site });
    }

    private withWriterIdentity(envelope: SessionEnvelope): SessionEnvelope {
        return {
            ...envelope,
            ...(this.tag ? { sid: this.tag } : {}),
            ...(this.site ? { site: this.site } : {}),
        };
    }

    // ── Outbound messages (queued for delivery on reconnect) ─────────────────

    /**
     * Queue a legacy `role:'agent'` record, stamped exactly as a connected client stamps it.
     * Counter on the line above the write, same reason as the envelope paths below.
     */
    private queueAgentRecord(record: SessionRecord, localId: string = randomUUID()): void {
        this.queueRecord(stampAgentRecord(record, { sid: this.tag, site: this.site, n: this.nextN++ }), localId);
    }

    sendCodexMessage(body: unknown): void {
        this.queueAgentRecord(buildCodexPayload(body));
    }

    sendCursorMessage(body: unknown): void {
        this.queueAgentRecord(buildCursorPayload(body));
    }

    sendOutputFormatMessage(data: OutputFormatData): void {
        this.queueAgentRecord(buildOutputFormatPayload(data));
    }

    sendAgentMessage(provider: ACPProvider, body: ACPMessageData): void {
        this.queueAgentRecord(buildAgentMessagePayload(provider, body));
    }

    sendClaudeSessionMessage(_body: RawJSONLines): void {}

    sendSessionProtocolMessage(envelope: SessionEnvelope, extraMeta?: Record<string, unknown>): void {
        // Counter issued on the line above the enqueue, as in ApiSessionClient: an `n`
        // without a matching durable write would be a permanent gap.
        const withN: SessionEnvelope = { ...this.withWriterIdentity(envelope), n: this.nextN++ };
        this.queueRecord(buildSessionProtocolPayload(withN, extraMeta), withN.id);
    }

    sendSessionLifecycleEnvelope(envelope: SessionEnvelope): void {
        const withN: SessionEnvelope = { ...this.withWriterIdentity(envelope), n: this.nextN++ };
        this.queueRecord(buildLifecyclePayload(withN), withN.id);
    }

    sendSessionEvent(event: SessionEventPayload, id?: string): void {
        const eventId = id ?? randomUUID();
        this.queueAgentRecord(buildSessionEventPayload(eventId, event), eventId);
    }

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
    getServerA2AUnreadCount(): number | undefined { return 0; }
    shouldEnqueueA2AInboxTurn(): boolean { return false; }
    noteA2ATriggersConsumed(_ids: string[]): void {}
    reconcileLocalA2AInboxWithServerAgentState(): number { return 0; }
    abandonLocalA2AInboxWhenServerDrained(): number { return 0; }
    recordA2AMessage(_message: A2AInboxMessage): void {}
    markA2AMessageRead(_id: string): void {}
    markA2AMessagesRead(_ids: string[]): void {}

    // ── Incoming message handler ──────────────────────────────────────────────

    onUserMessage(_callback: (data: unknown) => void): void {}

    // ── Connection state ──────────────────────────────────────────────────────

    isSocketConnected(): boolean { return false; }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /** Nothing to flush: every send is already on disk. The real client drains it on swap. */
    async flush(): Promise<void> {}
    async close(): Promise<void> {}
}

/**
 * Create an offline session stub that queues outbound messages durably.
 *
 * @param opts - Session identity and the content key to encrypt with. The key must be the
 *   one persisted before the failed create attempt, so the reconnected client can read back
 *   exactly these messages.
 * @returns An `ApiSessionClient` whose outbound messages are queued and whose server-backed
 *   operations are safe no-ops.
 */
export function createOfflineSessionStub(opts: OfflineSessionStubOptions): ApiSessionClient {
    return new OfflineSessionStub(opts) as unknown as ApiSessionClient;
}
