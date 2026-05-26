import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { A2AInboxState } from '@/api/types';

export const DEFAULT_A2A_INBOX_SNAPSHOT_KEEP_LATEST = 5;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function resolveA2AInboxSnapshotRetention(): { keepLatest: number; maxAgeMs: number } {
  const keepRaw = process.env.CURSOR_A2A_INBOX_SNAPSHOT_KEEP;
  const ageDaysRaw = process.env.CURSOR_A2A_INBOX_SNAPSHOT_MAX_AGE_DAYS;
  const keepParsed = keepRaw !== undefined && keepRaw !== '' ? Number.parseInt(keepRaw, 10) : DEFAULT_A2A_INBOX_SNAPSHOT_KEEP_LATEST;
  const ageDaysParsed = ageDaysRaw !== undefined && ageDaysRaw !== '' ? Number.parseInt(ageDaysRaw, 10) : 7;
  const keepLatest = Number.isFinite(keepParsed) && keepParsed >= 0 ? keepParsed : DEFAULT_A2A_INBOX_SNAPSHOT_KEEP_LATEST;
  const maxAgeMs = Number.isFinite(ageDaysParsed) && ageDaysParsed > 0
    ? ageDaysParsed * 24 * 60 * 60 * 1000
    : DEFAULT_MAX_AGE_MS;
  return { keepLatest, maxAgeMs };
}

/**
 * Delete old per-turn inbox snapshot JSON files for a session.
 * Keeps the newest `keepLatest` files; also deletes anything older than maxAgeMs.
 */
export function pruneA2AInboxSnapshots(
  dir: string,
  sessionId: string,
  options?: { keepLatest?: number; maxAgeMs?: number },
): number {
  if (!existsSync(dir)) {
    return 0;
  }

  const defaults = resolveA2AInboxSnapshotRetention();
  const keepLatest = options?.keepLatest ?? defaults.keepLatest;
  const maxAgeMs = options?.maxAgeMs ?? defaults.maxAgeMs;
  const prefix = `${sessionId}-`;
  const now = Date.now();

  const entries = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => {
      const path = join(dir, name);
      return { name, path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  let removed = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const overKeepLimit = keepLatest >= 0 && index >= keepLatest;
    const tooOld = now - entry.mtimeMs > maxAgeMs;
    if (overKeepLimit || tooOld) {
      unlinkSync(entry.path);
      removed += 1;
    }
  }

  return removed;
}

/** Write unread inbox rows to workspace/.happy/a2a-inbox for debugging; returns file path. */
export function writeA2AInboxSnapshot(
  workspacePath: string,
  sessionId: string,
  turnId: string,
  inbox: A2AInboxState | null | undefined,
): string {
  const dir = join(workspacePath, '.happy', 'a2a-inbox');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${sessionId}-${turnId}.json`);
  const unreadMessages = (inbox?.messages ?? [])
    .filter((message) => message.readAt == null)
    .slice(0, 100);
  const snapshot = {
    sessionId,
    turnId,
    unreadCount: unreadMessages.length,
    messages: unreadMessages,
  };
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  pruneA2AInboxSnapshots(dir, sessionId);
  return filePath;
}
