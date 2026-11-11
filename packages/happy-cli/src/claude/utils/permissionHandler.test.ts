import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler';

const makeSession = () => ({
  api: {
    push: vi.fn(() => ({
      sendToAllDevices: vi.fn(),
    })),
  },
  client: {
    sessionId: 'session-1',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
    },
    updateAgentState: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
  },
  queue: {
    unshift: vi.fn(),
  },
} as any);

describe('PermissionHandler', () => {
  it('treats yolo as bypassPermissions for tool approval', async () => {
    const handler = new PermissionHandler(makeSession());
    handler.handleModeChange('yolo');

    await expect(
      handler.handleToolCall('Bash', { command: 'echo hello' }, { permissionMode: 'default' } as any, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'echo hello' },
    });
  });

  it('still allows bypassPermissions directly', async () => {
    const handler = new PermissionHandler(makeSession());
    handler.handleModeChange('bypassPermissions');

    await expect(
      handler.handleToolCall('Bash', { command: 'echo hello' }, { permissionMode: 'default' } as any, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'echo hello' },
    });
  });

  it('emits a permission-request envelope when AskUserQuestion blocks on the user', async () => {
    const session = makeSession();
    const handler = new PermissionHandler(session);

    const input = { questions: [{ question: 'Proceed?', header: 'Action', options: [] }] };
    handler.onMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call_ask_1', name: 'AskUserQuestion', input }] },
    } as any);

    const pending = handler.handleToolCall('AskUserQuestion', input, { permissionMode: 'default' } as any, {
      signal: new AbortController().signal,
    });

    expect(session.client.sendSessionProtocolMessage).toHaveBeenCalledTimes(1);
    const envelope = vi.mocked(session.client.sendSessionProtocolMessage).mock.calls[0]?.[0];
    expect(envelope?.role).toBe('agent');
    expect(envelope?.ev).toEqual({
      t: 'permission-request',
      call: 'call_ask_1',
      tool: 'AskUserQuestion',
      input,
    });

    handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });
});
