import { describe, expect, it } from 'vitest';
import { directoryRows } from './directory';
import type { LanSessionSummary } from '../lanServer';

const full = (overrides: Partial<LanSessionSummary> = {}): LanSessionSummary => ({
  happySessionId: 'session-1',
  tag: 'tag-1',
  directory: '/home/user/project',
  agent: 'claude',
  startedBy: 'daemon',
  isAlive: true,
  lastHeartbeat: 1_000,
  metadataVersion: 7,
  metadata: 'ciphertext-that-the-directory-never-carries',
  dataEncryptionKey: 'wrapped-key',
  agentStateVersion: 9,
  agentState: 'agent-state-blob',
  createdAt: 900,
  updatedAt: 950,
  ...overrides,
});

describe('directoryRows', () => {
  it('carries only what the relay serves', () => {
    expect(directoryRows([full()])).toEqual([
      { happySessionId: 'session-1', tag: 'tag-1', isAlive: true },
    ]);
  });

  it('keeps origin when the row is an import of the server record', () => {
    expect(directoryRows([full({ origin: 'server' })])).toEqual([
      { happySessionId: 'session-1', tag: 'tag-1', isAlive: true, origin: 'server' },
    ]);
  });

  it('keeps a session the server has not named yet, addressed by its tag', () => {
    expect(directoryRows([full({ happySessionId: undefined })])).toEqual([
      { tag: 'tag-1', isAlive: true },
    ]);
  });

  it('drops a row with neither name, which no client could ask for', () => {
    expect(directoryRows([full({ happySessionId: undefined, tag: undefined })])).toEqual([]);
  });

  it('is unchanged when only the heartbeat moved, so the publisher stays quiet', () => {
    expect(JSON.stringify(directoryRows([full({ lastHeartbeat: 1_000 })])))
      .toBe(JSON.stringify(directoryRows([full({ lastHeartbeat: 2_000 })])));
  });

  it('reports liveness as a boolean, whatever the roster said', () => {
    expect(directoryRows([full({ isAlive: false })])[0].isAlive).toBe(false);
  });
});
