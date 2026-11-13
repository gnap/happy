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

  it('settles a pending request when the mode changes to bypassPermissions', async () => {
    const session = makeSession();
    const handler = new PermissionHandler(session);

    const input = { command: 'sleep 60' };
    handler.onMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call_bash_1', name: 'Bash', input }] },
    } as any);

    const pending = handler.handleToolCall('Bash', input, { permissionMode: 'default' } as any, {
      signal: new AbortController().signal,
    });
    expect(handler.hasPendingRequests()).toBe(true);

    handler.handleModeChange('bypassPermissions');

    expect(handler.hasPendingRequests()).toBe(false);
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: input });

    // First envelope is the request itself, second one is the settlement.
    const resultEnvelope = vi.mocked(session.client.sendSessionProtocolMessage).mock.calls[1]?.[0];
    expect(resultEnvelope?.role).toBe('agent');
    expect(resultEnvelope?.ev).toEqual(expect.objectContaining({
      t: 'permission-result',
      call: 'call_bash_1',
      status: 'approved',
      mode: 'bypassPermissions',
    }));
  });

  it('keeps AskUserQuestion pending across a bypassPermissions mode change', async () => {
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
    handler.handleModeChange('bypassPermissions');

    expect(handler.hasPendingRequests()).toBe(true);

    handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });

  it('settles only edit tools when the mode changes to acceptEdits', async () => {
    const session = makeSession();
    const handler = new PermissionHandler(session);

    const editInput = { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' };
    const bashInput = { command: 'rm -rf /tmp/x' };
    handler.onMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'call_edit_1', name: 'Edit', input: editInput },
          { type: 'tool_use', id: 'call_bash_1', name: 'Bash', input: bashInput },
        ],
      },
    } as any);

    const editPending = handler.handleToolCall('Edit', editInput, { permissionMode: 'default' } as any, {
      signal: new AbortController().signal,
    });
    const bashPending = handler.handleToolCall('Bash', bashInput, { permissionMode: 'default' } as any, {
      signal: new AbortController().signal,
    });

    handler.handleModeChange('acceptEdits');

    await expect(editPending).resolves.toEqual({ behavior: 'allow', updatedInput: editInput });
    expect(handler.hasPendingRequests()).toBe(true);

    handler.reset();
    await expect(bashPending).rejects.toThrow('Session reset');
  });
});
