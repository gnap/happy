/**
 * Unit tests for BasePermissionHandler: permission request flow and RPC response handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import {
  BasePermissionHandler,
  type PermissionResult,
  type PermissionResponse,
} from './BasePermissionHandler';

/** Minimal session mock: accumulates agent state and captures the permission RPC handler */
function createMockSession(): {
  session: ApiSessionClient;
  getAgentState: () => AgentState | null;
  getPermissionHandler: () => ((response: PermissionResponse) => Promise<void>) | null;
} {
  let agentState: AgentState | null = null;
  let permissionHandler: ((response: PermissionResponse) => Promise<void>) | null = null;

  const session = {
    updateAgentState: vi.fn((handler: (state: AgentState) => AgentState) => {
      const next = handler(agentState ?? {});
      agentState = next;
    }),
    rpcHandlerManager: {
      registerHandler: vi.fn((method: string, handler: (response: PermissionResponse) => Promise<void>) => {
        if (method === 'permission') {
          permissionHandler = handler;
        }
      }),
    },
  } as unknown as ApiSessionClient;

  return {
    session,
    getAgentState: () => agentState,
    getPermissionHandler: () => permissionHandler,
  };
}

/** Concrete handler for testing (mirrors GenericAcpPermissionHandler behavior) */
class TestPermissionHandler extends BasePermissionHandler {
  protected getLogPrefix(): string {
    return '[Test]';
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      (this as any).pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
      this.addPendingRequestToState(toolCallId, toolName, input);
    });
  }
}

describe('BasePermissionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('permission request and response', () => {
    it('adds request to agent state when handleToolCall is invoked', async () => {
      const { session, getAgentState, getPermissionHandler } = createMockSession();
      const handler = new TestPermissionHandler(session);

      const toolCallId = 'call-123';
      const toolName = 'run_terminal_cmd';
      const input = { command: 'echo hello' };

      const resultPromise = handler.handleToolCall(toolCallId, toolName, input);

      const state = getAgentState();
      expect(state?.requests?.[toolCallId]).toBeDefined();
      expect(state?.requests?.[toolCallId].tool).toBe(toolName);
      expect(state?.requests?.[toolCallId].arguments).toEqual(input);
      expect(typeof state?.requests?.[toolCallId].createdAt).toBe('number');

      const rpcHandler = getPermissionHandler();
      expect(rpcHandler).not.toBeNull();
      await rpcHandler!({ id: toolCallId, approved: true });

      const result = await resultPromise;
      expect(result.decision).toBe('approved');
    });

    it('resolves with approved_for_session when response.decision is approved_for_session', async () => {
      const { session, getPermissionHandler } = createMockSession();
      const handler = new TestPermissionHandler(session);

      const toolCallId = 'call-456';
      const resultPromise = handler.handleToolCall(toolCallId, 'ReadFile', { path: '/tmp/x' });

      const rpcHandler = getPermissionHandler();
      await rpcHandler!({ id: toolCallId, approved: true, decision: 'approved_for_session' });

      const result = await resultPromise;
      expect(result.decision).toBe('approved_for_session');
    });

    it('resolves with denied when approved is false and decision is denied', async () => {
      const { session, getPermissionHandler } = createMockSession();
      const handler = new TestPermissionHandler(session);

      const toolCallId = 'call-789';
      const resultPromise = handler.handleToolCall(toolCallId, 'Bash', {});

      const rpcHandler = getPermissionHandler();
      await rpcHandler!({ id: toolCallId, approved: false, decision: 'denied' });

      const result = await resultPromise;
      expect(result.decision).toBe('denied');
    });

    it('resolves with abort when approved is false without denied decision', async () => {
      const { session, getPermissionHandler } = createMockSession();
      const handler = new TestPermissionHandler(session);

      const toolCallId = 'call-abort';
      const resultPromise = handler.handleToolCall(toolCallId, 'WriteFile', {});

      const rpcHandler = getPermissionHandler();
      await rpcHandler!({ id: toolCallId, approved: false });

      const result = await resultPromise;
      expect(result.decision).toBe('abort');
    });

    it('moves request to completedRequests in state after permission response', async () => {
      const { session, getAgentState, getPermissionHandler } = createMockSession();
      const handler = new TestPermissionHandler(session);

      const toolCallId = 'call-completed';
      const resultPromise = handler.handleToolCall(toolCallId, 'ReadFile', { path: 'a.txt' });

      expect(getAgentState()?.requests?.[toolCallId]).toBeDefined();
      expect(getAgentState()?.completedRequests?.[toolCallId]).toBeUndefined();

      const rpcHandler = getPermissionHandler();
      await rpcHandler!({ id: toolCallId, approved: true });

      await resultPromise;

      const state = getAgentState();
      expect(state?.requests?.[toolCallId]).toBeUndefined();
      expect(state?.completedRequests?.[toolCallId]).toBeDefined();
      expect(state?.completedRequests?.[toolCallId].status).toBe('approved');
      expect(state?.completedRequests?.[toolCallId].decision).toBe('approved');
    });
  });

  describe('reset', () => {
    it('rejects pending permission requests and clears state', async () => {
      const { session, getAgentState, getPermissionHandler } = createMockSession();
      const handler = new TestPermissionHandler(session);

      const toolCallId = 'call-reset';
      const resultPromise = handler.handleToolCall(toolCallId, 'Bash', {});

      expect(getAgentState()?.requests?.[toolCallId]).toBeDefined();

      handler.reset();

      await expect(resultPromise).rejects.toThrow('Session reset');

      const state = getAgentState();
      expect(state?.requests?.[toolCallId]).toBeUndefined();
      expect(state?.completedRequests?.[toolCallId]?.status).toBe('canceled');
    });
  });
});
