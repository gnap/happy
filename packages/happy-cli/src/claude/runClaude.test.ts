import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockSession = {
    sessionId: 'session-1',
    updateMetadata: vi.fn(async () => undefined),
    updateAgentState: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    keepAlive: vi.fn(),
    onUserMessage: vi.fn(),
    rpcHandlerManager: {
      registerHandler: vi.fn(),
    },
  };

  const mockResponse = {
    id: 'session-1',
    seq: 1,
    metadata: {
      claudeSessionId: 'claude-chat-123',
    },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    encryptionKey: new Uint8Array([1, 2, 3]),
    encryptionVariant: 'legacy' as const,
  };

  return {
    mockSession,
    mockResponse,
    mockApiCreate: vi.fn(),
    mockGetOrCreateMachine: vi.fn(async () => ({ id: 'machine-1' })),
    mockGetOrCreateSession: vi.fn(async () => mockResponse),
    mockSessionSyncClient: vi.fn(() => mockSession),
    mockLoop: vi.fn(async () => 0),
    mockStartHappyServer: vi.fn(async () => ({
      url: 'http://127.0.0.1:9999',
      toolNames: ['bash'],
      stop: vi.fn(),
    })),
    mockStartHookServer: vi.fn(async () => ({
      port: 43210,
      stop: vi.fn(),
    })),
    mockGenerateHookSettingsFile: vi.fn(() => '/tmp/hook-settings.json'),
    mockCleanupHookSettingsFile: vi.fn(),
    mockExtractSDKMetadataAsync: vi.fn((cb: (metadata: { tools: string[]; slashCommands: string[] }) => void) => {
      void cb({ tools: ['Read'], slashCommands: ['/clear'] });
    }),
    mockNotifyDaemonSessionStarted: vi.fn(async () => ({ error: null })),
    mockNotifyDaemonSessionEnding: vi.fn(async () => undefined),
    mockRegisterKillSessionHandler: vi.fn(),
    mockReadSettings: vi.fn(async () => ({
      machineId: 'machine-1',
      sandboxConfig: undefined,
    })),
    mockWriteSessionPidFile: vi.fn(),
    mockRemoveSessionPidFile: vi.fn(),
    mockStartCaffeinate: vi.fn(() => false),
    mockStopCaffeinate: vi.fn(),
    mockProjectPath: vi.fn(() => '/tmp/happy-lib'),
    mockLoggerDebug: vi.fn(),
    mockLoggerDebugLargeJson: vi.fn(),
    mockLoggerInfoDeveloper: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockExistsSync: vi.fn(() => false),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockProcessExit: vi.fn(),
    mockSetInterval: vi.fn(),
  };
});

vi.mock('node:fs', () => ({
  existsSync: mocks.mockExistsSync,
  readFileSync: mocks.mockReadFileSync,
  writeFileSync: mocks.mockWriteFileSync,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
    debugLargeJson: mocks.mockLoggerDebugLargeJson,
    infoDeveloper: mocks.mockLoggerInfoDeveloper,
    info: mocks.mockLoggerInfo,
    warn: mocks.mockLoggerWarn,
  },
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.mockApiCreate,
  },
}));

vi.mock('@/claude/loop', () => ({
  loop: mocks.mockLoop,
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
  startHappyServer: mocks.mockStartHappyServer,
}));

vi.mock('@/claude/utils/startHookServer', () => ({
  startHookServer: mocks.mockStartHookServer,
}));

vi.mock('@/claude/utils/generateHookSettings', () => ({
  generateHookSettingsFile: mocks.mockGenerateHookSettingsFile,
  cleanupHookSettingsFile: mocks.mockCleanupHookSettingsFile,
}));

vi.mock('@/claude/sdk/metadataExtractor', () => ({
  extractSDKMetadataAsync: mocks.mockExtractSDKMetadataAsync,
}));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonSessionStarted: mocks.mockNotifyDaemonSessionStarted,
  notifyDaemonSessionEnding: mocks.mockNotifyDaemonSessionEnding,
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
  registerKillSessionHandler: mocks.mockRegisterKillSessionHandler,
}));

vi.mock('@/persistence', () => ({
  readSettings: mocks.mockReadSettings,
  writeSessionPidFile: mocks.mockWriteSessionPidFile,
  removeSessionPidFile: mocks.mockRemoveSessionPidFile,
}));

vi.mock('@/utils/caffeinate', () => ({
  startCaffeinate: mocks.mockStartCaffeinate,
  stopCaffeinate: mocks.mockStopCaffeinate,
}));

vi.mock('@/projectPath', () => ({
  projectPath: mocks.mockProjectPath,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happy-home',
    serverUrl: 'https://server.example.test',
  },
  serverHttpsAgent: undefined,
}));

vi.mock('@/daemon/run', () => ({
  initialMachineMetadata: {
    host: 'host',
    platform: 'linux',
    happyCliVersion: 'test',
    homeDir: '/home/test',
    happyHomeDir: '/tmp/happy-home',
    happyLibDir: '/tmp/happy-lib',
  },
}));

import { ApiClient } from '@/api/api';
import { runClaude } from './runClaude';
import { loop } from '@/claude/loop';

describe('runClaude resume plumbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockApiCreate.mockResolvedValue({
      getOrCreateMachine: mocks.mockGetOrCreateMachine,
      getOrCreateSession: mocks.mockGetOrCreateSession,
      sessionSyncClient: mocks.mockSessionSyncClient,
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined as never) as typeof process.exit);
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((() => 1) as unknown) as typeof setInterval);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores claudeSessionId from metadata into the next loop', async () => {
    await runClaude({} as any, {
      startedBy: 'daemon',
      startingMode: 'remote',
      resumeSessionTag: 'session-tag-1',
    });

    expect(ApiClient.create).toHaveBeenCalled();
    expect(mocks.mockGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'session-tag-1' }),
    );
    expect(loop).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSessionId: 'claude-chat-123',
      }),
    );
  });
});
