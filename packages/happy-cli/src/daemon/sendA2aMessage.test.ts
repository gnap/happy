import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockReadDaemonState: vi.fn(),
  mockReadCredentials: vi.fn(),
  mockReadFile: vi.fn(),
  mockExistsSync: vi.fn(),
  mockAxiosPost: vi.fn(),
  mockEncrypt: vi.fn((key: Uint8Array, _variant: unknown, payload: unknown) => payload),
  mockEncodeBase64: vi.fn(() => 'encoded'),
  mockBuildA2ASubagentCardEnvelopes: vi.fn(() => [
    { id: 'a2a-envelope-1', t: 'text', text: 'hello' },
  ]),
  mockWrapA2ASessionEnvelope: vi.fn((envelope: unknown) => envelope),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.mockAxiosPost,
  },
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.mockExistsSync,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.mockReadFile,
}));

vi.mock('@/persistence', () => ({
  readCredentials: mocks.mockReadCredentials,
  readDaemonState: mocks.mockReadDaemonState,
}));

vi.mock('@/api/encryption', () => ({
  encrypt: mocks.mockEncrypt,
  encodeBase64: mocks.mockEncodeBase64,
}));

vi.mock('@/a2a/subagentCard', () => ({
  buildA2ASubagentCardEnvelopes: mocks.mockBuildA2ASubagentCardEnvelopes,
  wrapA2ASessionEnvelope: mocks.mockWrapA2ASessionEnvelope,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/home/test/.happy',
    serverUrl: 'https://server.example.test',
  },
  serverHttpsAgent: undefined,
}));

import { sendA2aMessage } from './sendA2aMessage';

describe('sendA2aMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockReadCredentials.mockResolvedValue({
      token: 'token-1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3]),
      },
    });
    mocks.mockAxiosPost.mockResolvedValue({
      data: {
        messages: [
          { id: 'msg-1', seq: 1 },
        ],
      },
    });
    mocks.mockReadFile.mockResolvedValue('Y2xpLXNlY3JldA==');
    mocks.mockEncodeBase64.mockReturnValue('encoded');
  });

  it('uses the Claude session key for Claude sessions', async () => {
    mocks.mockReadDaemonState.mockResolvedValue({
      lastAgentBySessionId: { 'session-claude': 'claude' },
      lastSessionTagBySessionId: { 'session-claude': 'tag-claude' },
      lastSessionTagByDirectory: {},
      lastDirectoryBySessionId: {},
    });
    mocks.mockExistsSync.mockImplementation((path: string) => path.endsWith('claude-session-key-tag-claude'));

    const result = await sendA2aMessage('session-claude', 'hello from a2a');

    expect(result).toEqual({
      success: true,
      messageId: 'msg-1',
      seq: 1,
    });
    expect(mocks.mockReadFile).toHaveBeenCalledWith('/home/test/.happy/claude-session-key-tag-claude', 'utf8');
    expect(mocks.mockAxiosPost).toHaveBeenCalledWith(
      'https://server.example.test/v3/sessions/session-claude/messages',
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: 'encoded',
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it('uses the Cursor session key for Cursor sessions', async () => {
    mocks.mockReadDaemonState.mockResolvedValue({
      lastAgentBySessionId: { 'session-cursor': 'cursor' },
      lastSessionTagBySessionId: { 'session-cursor': 'tag-cursor' },
      lastSessionTagByDirectory: {},
      lastDirectoryBySessionId: {},
    });
    mocks.mockExistsSync.mockImplementation((path: string) => path.endsWith('cursor-session-key-tag-cursor'));

    const result = await sendA2aMessage('session-cursor', 'hello from a2a');

    expect(result).toEqual({
      success: true,
      messageId: 'msg-1',
      seq: 1,
    });
    expect(mocks.mockReadFile).toHaveBeenCalledWith('/home/test/.happy/cursor-session-key-tag-cursor', 'utf8');
  });
});
