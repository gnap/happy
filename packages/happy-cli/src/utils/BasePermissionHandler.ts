/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { AgentState } from "@/api/types";
import { createEnvelope } from '@slopus/happy-wire';

/**
 * Permission response from the mobile app.
 */
export interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    updatedInput?: Record<string, unknown>;
}

/**
 * Pending permission request stored while awaiting user response.
 */
export interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

/**
 * Result of a permission request.
 */
export interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

/**
 * Abstract base class for permission handlers.
 *
 * Subclasses must implement:
 * - `getLogPrefix()` - returns the log prefix (e.g., '[Codex]')
 */
export abstract class BasePermissionHandler {
    protected pendingRequests = new Map<string, PendingRequest>();
    protected session: ApiSessionClient;
    private isResetting = false;

    /**
     * Returns the log prefix for this handler.
     */
    protected abstract getLogPrefix(): string;

    constructor(session: ApiSessionClient) {
        this.session = session;
        this.setupRpcHandler();
    }

    /**
     * Update the session reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale session references after onSessionSwap.
     */
    updateSession(newSession: ApiSessionClient): void {
        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
    }

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug(`${this.getLogPrefix()} Permission request not found or already resolved`);
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);

                // Resolve the permission request
                const result: PermissionResult = response.approved
                    ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved' }
                    : { decision: response.decision === 'denied' ? 'denied' : 'abort' };

                pending.resolve(result);

                // Emit permission-result as a replayable session protocol envelope.
                // This embeds the permission decision into the message stream so the
                // App reducer can replay it from cached messages rather than relying
                // solely on agentState.completedRequests.
                this.session.client.sendSessionProtocolMessage(
                    createEnvelope('agent', {
                        t: 'permission-result',
                        call: response.id,
                        status: response.approved ? 'approved' : 'denied',
                        decision: result.decision,
                        ...(response.mode ? { mode: response.mode } : {}),
                        ...(response.allowTools ? { allowedTools: response.allowTools } : {}),
                        ...(response.reason ? { reason: response.reason } : {}),
                        ...(response.updatedInput ? { updatedInput: response.updatedInput } : {}),
                    }),
                );

                // Move request to completed in agent state, trimmed to last 20.
                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    const entries = Object.entries({ ...currentState.completedRequests, [response.id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: response.approved ? 'approved' : 'denied',
                        decision: result.decision,
                    } }).slice(-20);

                    let res = {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: Object.fromEntries(entries),
                    } satisfies AgentState;
                    return res;
                });

                logger.debug(`${this.getLogPrefix()} Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
            }
        );
    }

    /**
     * Add a pending request to the agent state.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown): void {
        this.session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [toolCallId]: {
                    tool: toolName,
                    arguments: input,
                    createdAt: Date.now()
                }
            }
        }));
    }

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    reset(): void {
        // Guard against re-entrant/concurrent resets
        if (this.isResetting) {
            logger.debug(`${this.getLogPrefix()} Reset already in progress, skipping`);
            return;
        }
        this.isResetting = true;

        try {
            // Snapshot pending requests to avoid Map mutation during iteration
            const pendingSnapshot = Array.from(this.pendingRequests.entries());
            this.pendingRequests.clear(); // Clear immediately to prevent new entries being processed

            // Reject all pending requests from snapshot
            for (const [id, pending] of pendingSnapshot) {
                try {
                    pending.reject(new Error('Session reset'));
                } catch (err) {
                    logger.debug(`${this.getLogPrefix()} Error rejecting pending request ${id}:`, err);
                }
            }

            // Clear requests in agent state, emit canceled envelopes.
            this.session.updateAgentState((currentState) => {
                const pendingRequests = currentState.requests || {};

                // Emit canceled permission-result envelopes for each pending request
                // so the App reducer can replay them from the message stream.
                for (const [id] of Object.entries(pendingRequests)) {
                    this.session.client.sendSessionProtocolMessage(
                        createEnvelope('agent', {
                            t: 'permission-result',
                            call: id,
                            status: 'canceled',
                            reason: 'Session reset',
                        }),
                    );
                }

                // Trim completedRequests to last 20
                const completedEntries = Object.entries({ ...currentState.completedRequests });
                for (const [id, request] of Object.entries(pendingRequests)) {
                    completedEntries.push([id, {
                        ...request,
                        completedAt: Date.now(),
                        status: 'canceled' as const,
                        reason: 'Session reset',
                    }]);
                }
                const trimmed = completedEntries.slice(-20);

                return {
                    ...currentState,
                    requests: {},
                    completedRequests: Object.fromEntries(trimmed),
                };
            });

            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }
}
