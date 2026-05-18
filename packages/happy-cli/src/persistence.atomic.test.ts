import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const testState = vi.hoisted(() => ({
  root: `/tmp/happy-persistence-${process.pid}-${Date.now()}`,
  failTempWriteFor: null as string | null,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: testState.root,
    logsDir: `${testState.root}/logs`,
    settingsFile: `${testState.root}/settings.json`,
    privateKeyFile: `${testState.root}/access.key`,
    daemonStateFile: `${testState.root}/daemon.state.json`,
    daemonLockFile: `${testState.root}/daemon.state.json.lock`,
  }
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  return {
    ...actual,
    writeFileSync: vi.fn((path, data, options) => {
      const stringPath = String(path);
      const failBasename = testState.failTempWriteFor;
      const isTargetTempFile = !!failBasename &&
        stringPath.includes(`.${failBasename}.`) &&
        stringPath.endsWith('.tmp');

      if (isTargetTempFile) {
        actual.writeFileSync(path, '', options);
        const error = new Error('disk full');
        (error as NodeJS.ErrnoException).code = 'ENOSPC';
        throw error;
      }

      return actual.writeFileSync(path, data, options);
    }),
  };
});

import { writeCredentialsLegacy, writeDaemonState } from './persistence';

describe('atomic persistence writes', () => {
  beforeEach(() => {
    testState.failTempWriteFor = null;
    rmSync(testState.root, { recursive: true, force: true });
    mkdirSync(testState.root, { recursive: true });
  });

  afterAll(() => {
    rmSync(testState.root, { recursive: true, force: true });
  });

  it('preserves existing daemon state when temp write fails', () => {
    const daemonStatePath = `${testState.root}/daemon.state.json`;
    const originalContent = JSON.stringify({
      pid: 123,
      httpPort: 456,
      startedWithCliVersion: '0.1.0',
    }, null, 2);

    writeFileSync(daemonStatePath, originalContent, 'utf8');
    testState.failTempWriteFor = 'daemon.state.json';

    expect(() => writeDaemonState({
      pid: 999,
      httpPort: 888,
      startedWithCliVersion: '0.2.0',
    })).toThrow(/disk full/);

    expect(readFileSync(daemonStatePath, 'utf8')).toBe(originalContent);
    expect(readdirSync(testState.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves existing credentials when temp write fails', async () => {
    const credentialsPath = `${testState.root}/access.key`;
    const originalContent = JSON.stringify({
      token: 'original-token',
      secret: 'b2xkLXNlY3JldA==',
    }, null, 2);

    writeFileSync(credentialsPath, originalContent, 'utf8');
    testState.failTempWriteFor = 'access.key';

    await expect(writeCredentialsLegacy({
      token: 'new-token',
      secret: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow(/disk full/);

    expect(readFileSync(credentialsPath, 'utf8')).toBe(originalContent);
    expect(readdirSync(testState.root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
