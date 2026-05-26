/**
 * Lock-guarded Cursor CLI maxMode toggling (ported from AutoSkill cursor_max_mode.py).
 *
 * cursor-agent snapshots maxMode from ~/.cursor/cli-config.json at startup; there is
 * no CLI flag. We take an exclusive lock, write the desired value, spawn the process,
 * then release after the first stream-json `system` event (init snapshot captured).
 */

import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const LOCK_PATH = join(tmpdir(), 'happy-cursor-maxmode.lock');
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 50;

export function cursorCliConfigPath(): string {
  const configDir = process.env.CURSOR_CONFIG_DIR?.trim();
  if (configDir) {
    return join(configDir, 'cli-config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return join(xdg, 'cursor', 'cli-config.json');
  }
  return join(homedir(), '.cursor', 'cli-config.json');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockOwnerPid(): Promise<number | null> {
  try {
    const raw = await readFile(LOCK_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: number };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function tryClearStaleLock(): Promise<void> {
  const ownerPid = await readLockOwnerPid();
  if (ownerPid === null || !isProcessAlive(ownerPid)) {
    try {
      await unlink(LOCK_PATH);
    } catch {
      /* ignore */
    }
  }
}

async function acquireLock(): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(LOCK_PATH, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        throw error;
      }
      await tryClearStaleLock();
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  throw new Error(`cursor max mode lock timeout after ${LOCK_TIMEOUT_MS}ms`);
}

async function releaseLock(): Promise<void> {
  const ownerPid = await readLockOwnerPid();
  if (ownerPid !== process.pid) {
    return;
  }
  try {
    await unlink(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

export async function atomicSetCursorMaxMode(value: boolean): Promise<void> {
  const cfgPath = cursorCliConfigPath();
  const raw = await readFile(cfgPath, 'utf8');
  const cfg = JSON.parse(raw) as Record<string, unknown>;
  cfg.maxMode = value;
  const model = cfg.model;
  if (model && typeof model === 'object' && !Array.isArray(model)) {
    (model as Record<string, unknown>).maxMode = value;
  } else {
    cfg.model = { maxMode: value };
  }
  const dir = dirname(cfgPath);
  const tmpPath = join(dir, `.cli-config.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(cfg, null, 2)}\n`;
  await writeFile(tmpPath, body, 'utf8');
  await rename(tmpPath, cfgPath);
}

export type CursorMaxModeGuard = {
  release: () => Promise<void>;
};

/**
 * Hold an exclusive lock, set maxMode, return release callback (call after system init).
 */
export async function acquireCursorMaxModeGuard(maxMode: boolean): Promise<CursorMaxModeGuard> {
  await acquireLock();
  await atomicSetCursorMaxMode(maxMode);
  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await releaseLock();
    },
  };
}

export function isCursorStreamInitMessage(msg: { type?: string }): boolean {
  return msg.type === 'system';
}
