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
});
