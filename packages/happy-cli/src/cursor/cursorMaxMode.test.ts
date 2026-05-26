import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  atomicSetCursorMaxMode,
  cursorCliConfigPath,
  isCursorStreamInitMessage,
} from './cursorMaxMode';

describe('atomicSetCursorMaxMode', () => {
  let configDir: string;
  const prevConfigDir = process.env.CURSOR_CONFIG_DIR;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'happy-cursor-maxmode-'));
    process.env.CURSOR_CONFIG_DIR = configDir;
    await writeFile(join(configDir, 'cli-config.json'), JSON.stringify({
      maxMode: true,
      model: { modelId: 'composer-2.5', maxMode: true },
    }, null, 2));
  });

  afterEach(async () => {
    if (prevConfigDir === undefined) {
      delete process.env.CURSOR_CONFIG_DIR;
    } else {
      process.env.CURSOR_CONFIG_DIR = prevConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
  });

  it('writes root and model maxMode', async () => {
    await atomicSetCursorMaxMode(false);
    const cfg = JSON.parse(await readFile(cursorCliConfigPath(), 'utf8')) as {
      maxMode: boolean;
      model: { maxMode: boolean };
    };
    expect(cfg.maxMode).toBe(false);
    expect(cfg.model.maxMode).toBe(false);
  });

  it('clears residual true when disabling', async () => {
    await atomicSetCursorMaxMode(true);
    await atomicSetCursorMaxMode(false);
    const cfg = JSON.parse(await readFile(cursorCliConfigPath(), 'utf8')) as {
      maxMode: boolean;
      model: { maxMode: boolean };
    };
    expect(cfg.maxMode).toBe(false);
    expect(cfg.model.maxMode).toBe(false);
  });
});

describe('isCursorStreamInitMessage', () => {
  it('matches stream-json system init', () => {
    expect(isCursorStreamInitMessage({ type: 'system' })).toBe(true);
    expect(isCursorStreamInitMessage({ type: 'assistant' })).toBe(false);
  });
});
