import { beforeEach, describe, expect, it, vi } from 'vitest';

const readDaemonState = vi.fn();

vi.mock('@/persistence', () => ({
  readDaemonState,
  clearDaemonState: vi.fn(),
}));

vi.mock('@/projectPath', () => ({
  projectPath: () => '/tmp/happy',
}));

describe('getDaemonA2aMessageUri', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds stable daemon A2A URI from daemon state', async () => {
    readDaemonState.mockResolvedValue({ pid: process.pid, httpPort: 43123 });
    const { getDaemonA2aMessageUri } = await import('./controlClient');

    await expect(getDaemonA2aMessageUri('session-123')).resolves.toBe(
      'http://127.0.0.1:43123/a2a/session-123/message',
    );
  });

  it('returns null when daemon state is unavailable', async () => {
    readDaemonState.mockResolvedValue(null);
    const { getDaemonA2aMessageUri } = await import('./controlClient');

    await expect(getDaemonA2aMessageUri('session-123')).resolves.toBeNull();
  });
});
