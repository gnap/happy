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
    // Enough of the A2A surface for the startup path, which peeks the inbox to decide
    // whether an inbox turn is due before it reaches the (mocked) loop.
    getA2AInbox: vi.fn(() => ({ messages: [] })),
    getMetadata: vi.fn(() => null),
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
    // `unknown` so the offline test can make it resolve null, which is what the server
    // being unreachable looks like from here; the parameter is typed so the test can read
    // back the options each attempt was made with.
    mockGetOrCreateSession: vi.fn(async (_opts: { tag: string; [key: string]: unknown }): Promise<unknown> => mockResponse),
    mockSessionSyncClient: vi.fn((..._args: unknown[]) => mockSession),
    // A tag that has not been through the server yet has no cached binding; tests that start
    // from one override this.
    mockLoadCachedSession: vi.fn((_opts: unknown): unknown => null),
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
      // Asynchronously, as the real extractor does: runClaude assigns `session` after this
      // call returns, and the callback dereferences it. Firing it inline hit the temporal
      // dead zone and failed the resume test for a reason that had nothing to do with resume.
      queueMicrotask(() => cb({ tools: ['Read'], slashCommands: ['/clear'] }));
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
    mockStartOfflineReconnection: vi.fn((_opts: { onReconnected: () => Promise<unknown> }) => ({ cancel: vi.fn() })),
    mockClaudeLocal: vi.fn(async () => undefined),
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

vi.mock('@/utils/serverConnectionErrors', () => ({
  startOfflineReconnection: mocks.mockStartOfflineReconnection,
  connectionState: { setBackend: vi.fn(), notifyOffline: vi.fn() },
}));

vi.mock('@/claude/claudeLocal', () => ({
  claudeLocal: mocks.mockClaudeLocal,
}));

// The real backoff waits 5s+ between attempts, which the offline test below would have to sit
// through. Retry immediately instead; the schedule itself is not what that test is about.
vi.mock('@/utils/time', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/time')>()),
  createBackoff: () => async <T>(callback: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await callback();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  },
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
      loadCachedSession: mocks.mockLoadCachedSession,
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

  /**
   * When the server is unreachable at startup the session waits for it rather than running
   * Claude locally. A local run is a different execution mode that the App cannot drive, and
   * its failure would take the whole process — and so the session — down with it.
   *
   * Both attempts must use the same tag: it keys the session on the server and buckets the
   * local log, outbox and encryption key, so a fresh one would surface the same conversation
   * as a second session and split its history in two.
   */
  it('waits for the server under the original tag instead of running Claude locally', async () => {
    mocks.mockGetOrCreateSession.mockResolvedValueOnce(null);
    mocks.mockGetOrCreateSession.mockResolvedValueOnce(mocks.mockResponse);

    await runClaude({} as any, {
      startedBy: 'daemon',
      startingMode: 'remote',
      resumeSessionTag: 'session-tag-1',
    });

    const attemptedTags = mocks.mockGetOrCreateSession.mock.calls.map((call) => call[0].tag);
    expect(attemptedTags).toEqual(['session-tag-1', 'session-tag-1']);
    // It reached the ordinary startup path rather than exiting after a local run.
    expect(loop).toHaveBeenCalled();
  });

  /**
   * Local mode is someone at the terminal, and the App never drives it. Its behaviour when the
   * server is unreachable is therefore left exactly as it was: run Claude locally so that
   * person keeps working, then mirror the transcript up on reconnect.
   */
  it('still runs Claude locally when a terminal session cannot reach the server', async () => {
    mocks.mockGetOrCreateSession.mockResolvedValue(null);
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(runClaude({} as any, {
      startedBy: 'terminal',
      startingMode: 'local',
      resumeSessionTag: 'session-tag-1',
    })).rejects.toThrow('process.exit');

    expect(mocks.mockClaudeLocal).toHaveBeenCalled();
    expect(mocks.mockStartOfflineReconnection).toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
  });

  /**
   * A tag the server has answered for before starts from that record. The session must come up,
   * report to the daemon under the cached id (which is what lets the LAN serve it), and run its
   * loop while the server's answer is still outstanding -- only server ingest waits for it.
   */
  it('starts from a cached binding without waiting for a slow server', async () => {
    mocks.mockLoadCachedSession.mockReturnValueOnce({ ...mocks.mockResponse, seq: 0 });
    mocks.mockGetOrCreateSession.mockReturnValue(new Promise(() => {}));

    await runClaude({} as any, {
      startedBy: 'daemon',
      startingMode: 'remote',
      resumeSessionTag: 'session-tag-1',
    });

    expect(mocks.mockSessionSyncClient).toHaveBeenCalledWith(
      expect.anything(),
      true,
      expect.objectContaining({ serverCursorPending: true }),
    );
    expect(mocks.mockNotifyDaemonSessionStarted).toHaveBeenCalledWith('session-1', expect.anything());
    expect(loop).toHaveBeenCalled();
  });

  it('settles the server cursor when the answer arrives after a cached start', async () => {
    mocks.mockLoadCachedSession.mockReturnValueOnce({ ...mocks.mockResponse, seq: 0 });
    const resolveServerSession = vi.fn(() => true);
    (mocks.mockSession as Record<string, unknown>).resolveServerSession = resolveServerSession;
    mocks.mockGetOrCreateSession.mockResolvedValue({ ...mocks.mockResponse, seq: 77 });

    await runClaude({} as any, {
      startedBy: 'daemon',
      startingMode: 'remote',
      resumeSessionTag: 'session-tag-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(resolveServerSession).toHaveBeenCalledWith(expect.objectContaining({ seq: 77 }));
  });
});
