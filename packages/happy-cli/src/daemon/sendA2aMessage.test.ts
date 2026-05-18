import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockReadDaemonState: vi.fn(),
  mockReadCredentials: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockAxiosPost: vi.fn(),
  mockEncrypt: vi.fn((key: Uint8Array, _variant: unknown, payload: unknown) => payload),
  mockEncodeBase64: vi.fn(() => 'encoded'),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.mockAxiosPost,
  },
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.mockExistsSync,
  mkdirSync: mocks.mockMkdirSync,
  readFileSync: mocks.mockReadFileSync,
  writeFileSync: mocks.mockWriteFileSync,
}));

vi.mock('@/persistence', () => ({
  readCredentials: mocks.mockReadCredentials,
  readDaemonState: mocks.mockReadDaemonState,
}));

vi.mock('@/api/encryption', () => ({
  encrypt: mocks.mockEncrypt,
  encodeBase64: mocks.mockEncodeBase64,
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
    mocks.mockReadFileSync.mockReturnValue('Y2xpLXNlY3JldA==');
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
    expect(mocks.mockReadFileSync).toHaveBeenCalledWith('/home/test/.happy/claude-session-key-tag-claude', 'utf8');
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
    expect(mocks.mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\/home\/test\/\.happy\/a2a-inbox\/session-claude-\d+\.json$/),
      expect.stringContaining('"title": "A2A inbox (1 unread)"'),
      'utf8',
    );
    expect(mocks.mockEncrypt.mock.calls[0][2]).toEqual(expect.objectContaining({
      role: 'user',
      localKey: expect.stringMatching(/^session-claude-\d+$/),
      content: expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('A2A inbox (1 unread).'),
      }),
      meta: expect.objectContaining({
        origin: 'a2a',
        a2aTrigger: true,
      }),
      a2aInboxMessage: expect.objectContaining({
        title: null,
        text: 'hello from a2a',
      }),
    }));
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
    expect(mocks.mockReadFileSync).toHaveBeenCalledWith('/home/test/.happy/cursor-session-key-tag-cursor', 'utf8');
  });
});
