import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import type { ApiSessionClient } from '@/api/apiSession';
import {
  buildA2AInboxNotificationWithPreview,
  getA2AUnreadCount,
  hasUnreadA2AInboxMessages,
  listA2AInboxMessages,
  pruneA2AInboxSnapshots,
  writeA2AInboxSnapshot,
} from '@/a2a/inbox';
import { a2aInboxBackoffDelayMs, isA2AInboxBackoffActive, resolveA2AInboxBackoffSettings } from '@/a2a/inboxBackoff';
import { configuration } from '@/configuration';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { logger } from '@/ui/logger';
import type { MessageQueue2 } from '@/utils/MessageQueue2';

export const A2A_INBOX_TURN_META = { a2aInboxTurn: true } as const;

export function isA2AInboxTurnMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') {
    return false;
  }
  return (meta as { a2aInboxTurn?: boolean }).a2aInboxTurn === true;
}

export type A2AInboxTurnHooks = {
  isInboxTurnMeta: (meta: unknown) => boolean;
  setInboxTurnActive: (active: boolean) => void;
  isInboxTurnActive: () => boolean;
  /** Build internal prompt for an inbox turn; null means skip (no unread rows). */
  prepareInboxTurnPrompt: () => string | null;
  onTurnEnd: (result: { succeeded: boolean; cancelled: boolean; wasInboxTurn: boolean }) => void;
  peekInbox: () => void;
  dispose: () => void;
};

export function createA2AInboxTurnController<TMode>(options: {
  logTag: string;
  messageQueue: MessageQueue2<TMode>;
  session: ApiSessionClient;
  getMode: () => TMode;
  isAgentTurnActive: () => boolean;
  workspacePath: string;
  sessionId: string;
  buildTurnPrompt: (notification: string, snapshotPath: string | undefined, unreadCount: number) => string;
  /** Optional: schedule /compact from inbox via pushIsolateAndClear */
  scheduleCompactTurn?: (mode: TMode) => void;
}): A2AInboxTurnHooks {
  const {
    logTag,
    messageQueue,
    session,
    getMode,
    isAgentTurnActive,
    workspacePath,
    sessionId,
    buildTurnPrompt,
    scheduleCompactTurn,
  } = options;

  let a2aTurnQueued = false;
  let a2aInboxTurnActive = false;
  let a2aInboxBackoffStreak = 0;
  let a2aInboxBackoffUntil = 0;
  let a2aInboxBackoffTimer: ReturnType<typeof setTimeout> | null = null;
  const a2aInboxBackoffSettings = resolveA2AInboxBackoffSettings();

  const scheduleA2AInboxRetryPeek = (delayMs: number) => {
    if (a2aInboxBackoffTimer !== null) {
      clearTimeout(a2aInboxBackoffTimer);
      a2aInboxBackoffTimer = null;
    }
    if (delayMs <= 0) {
      return;
    }
    a2aInboxBackoffTimer = setTimeout(() => {
      a2aInboxBackoffTimer = null;
      messageQueue.poke();
    }, delayMs);
  };

  const clearA2AInboxBackoff = () => {
    a2aInboxBackoffStreak = 0;
    a2aInboxBackoffUntil = 0;
    if (a2aInboxBackoffTimer !== null) {
      clearTimeout(a2aInboxBackoffTimer);
      a2aInboxBackoffTimer = null;
    }
  };

  const scheduleA2ATurnIfNeeded = () => {
    if (isAgentTurnActive() || a2aInboxTurnActive) {
      logger.debug(`[${logTag}] Deferring A2A inbox turn until the active turn finishes`);
      return;
    }
    if (isA2AInboxBackoffActive(a2aInboxBackoffUntil)) {
      logger.debug(
        `[${logTag}] A2A inbox backoff active (streak ${a2aInboxBackoffStreak}, `
        + `retry in ${a2aInboxBackoffUntil - Date.now()}ms)`,
      );
      return;
    }
    const unreadMessages = listA2AInboxMessages(session.getA2AInbox(), { unreadOnly: true });
    const compactMessage = unreadMessages.find((message) => parseSpecialCommand(message.text).type === 'compact');
    if (compactMessage && scheduleCompactTurn) {
      if (a2aTurnQueued) {
        return;
      }
      a2aTurnQueued = true;
      logger.debug(`[${logTag}] A2A compact command peek: scheduling compression for message ${compactMessage.id}`);
      session.markA2AMessageRead(compactMessage.id);
      scheduleCompactTurn(getMode());
      return;
    }
    const unreadCount = unreadMessages.length;
    if (unreadCount === 0) {
      return;
    }
    if (a2aTurnQueued) {
      return;
    }
    a2aTurnQueued = true;
    logger.debug(`[${logTag}] A2A inbox peek: scheduling turn for ${unreadCount} unread message(s)`);
    messageQueue.pushIsolated('', getMode(), A2A_INBOX_TURN_META);
  };

  return {
    isInboxTurnMeta: isA2AInboxTurnMeta,
    setInboxTurnActive: (active: boolean) => {
      a2aInboxTurnActive = active;
    },
    isInboxTurnActive: () => a2aInboxTurnActive,
    prepareInboxTurnPrompt: () => {
      a2aTurnQueued = false;
      if (!hasUnreadA2AInboxMessages(session.getA2AInbox())) {
        logger.debug(`[${logTag}] A2A inbox turn dequeued with no unread messages; skipping`);
        return null;
      }
      const turnId = createId();
      const inbox = session.getA2AInbox();
      const unreadCount = getA2AUnreadCount(inbox);
      const snapshotPath = writeA2AInboxSnapshot(workspacePath, sessionId, turnId, inbox);
      const summary = buildA2AInboxNotificationWithPreview(inbox);
      return buildTurnPrompt(summary, snapshotPath, unreadCount);
    },
    onTurnEnd: ({ succeeded, cancelled, wasInboxTurn }) => {
      if (wasInboxTurn) {
        a2aInboxTurnActive = false;
        if (succeeded) {
          clearA2AInboxBackoff();
          logger.debug(`[${logTag}] A2A inbox turn succeeded; backoff reset`);
        } else if (!cancelled) {
          a2aInboxBackoffStreak += 1;
          const delayMs = a2aInboxBackoffDelayMs(a2aInboxBackoffStreak, a2aInboxBackoffSettings);
          a2aInboxBackoffUntil = Date.now() + delayMs;
          logger.debug(
            `[${logTag}] A2A inbox turn failed; backing off ${delayMs}ms (streak ${a2aInboxBackoffStreak})`,
          );
          scheduleA2AInboxRetryPeek(delayMs);
        }
      } else if (succeeded) {
        clearA2AInboxBackoff();
      }
      if (!isA2AInboxBackoffActive(a2aInboxBackoffUntil)) {
        scheduleA2ATurnIfNeeded();
      }
    },
    peekInbox: () => {
      scheduleA2ATurnIfNeeded();
    },
    dispose: () => {
      if (a2aInboxBackoffTimer !== null) {
        clearTimeout(a2aInboxBackoffTimer);
        a2aInboxBackoffTimer = null;
      }
    },
  };
}

/** Call once at session start (after session id is known). */
export function isA2ATriggerMessage(meta: unknown): boolean {
  return (meta as { a2aTrigger?: boolean } | undefined)?.a2aTrigger === true;
}

export function pruneA2AInboxOnSessionStart(
  logTag: string,
  workspacePath: string,
  sessionId: string,
  startedByDaemon: boolean,
): void {
  const workspaceInboxDir = join(workspacePath, '.happy', 'a2a-inbox');
  const prunedWorkspaceSnapshots = pruneA2AInboxSnapshots(workspaceInboxDir, sessionId);
  const daemonInboxDir = join(configuration.happyHomeDir, 'a2a-inbox');
  const prunedDaemonSnapshots = startedByDaemon
    ? pruneA2AInboxSnapshots(daemonInboxDir, sessionId)
    : 0;
  if (prunedWorkspaceSnapshots + prunedDaemonSnapshots > 0) {
    logger.debug(
      `[${logTag}] Pruned ${prunedWorkspaceSnapshots + prunedDaemonSnapshots} A2A inbox snapshot file(s) on session start`,
    );
  }
}
