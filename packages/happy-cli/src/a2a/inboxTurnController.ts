import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import type { ApiSessionClient } from '@/api/apiSession';
import {
  buildA2AInboxNotificationWithPreview,
  getA2AUnreadCount,
  hasUnreadA2AInboxMessages,
  isA2AInboxTurnConsumed,
  listA2AInboxMessages,
  pruneA2AInboxSnapshots,
  writeA2AInboxSnapshot,
} from '@/a2a/inbox';
import { a2aInboxBackoffDelayMs, isA2AInboxBackoffActive, resolveA2AInboxBackoffSettings } from '@/a2a/inboxBackoff';
import { configuration } from '@/configuration';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { logger } from '@/ui/logger';
import { A2AInboxMcpScopeStack } from '@/a2a/inboxMcpScopeStack';
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
  isInboxMcpAllowed: () => boolean;
  describeInboxMcpScope: () => string;
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
  const inboxMcpScopeStack = new A2AInboxMcpScopeStack();
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
    // After backoff expires, just try scheduling. If the while-loop is
    // still mid-turn the push will land in the queue and get picked up
    // on the next iteration.
    a2aInboxBackoffTimer = setTimeout(() => {
      a2aInboxBackoffTimer = null;
      scheduleA2ATurnIfNeeded();
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
    // When a turn is already queued, no need to push another.
    // It will be dequeued by the launcher on the next loop iteration.
    if (a2aTurnQueued) {
      return;
    }
    // Honour backoff after failed inbox turns.
    if (isA2AInboxBackoffActive(a2aInboxBackoffUntil)) {
      logger.debug(
        `[${logTag}] A2A inbox backoff active (streak ${a2aInboxBackoffStreak}, `
        + `retry in ${a2aInboxBackoffUntil - Date.now()}ms)`,
      );
      return;
    }
    // Only schedule when the local inbox has unread rows.
    if (!hasUnreadA2AInboxMessages(session.getA2AInbox())) {
      return;
    }
    a2aTurnQueued = true;
    const unread = listA2AInboxMessages(session.getA2AInbox(), { unreadOnly: true });
    const unreadCount = unread.length;
    // Check for a compact command in the inbox.
    const compactMessage = unread.find((message) => parseSpecialCommand(message.text).type === 'compact');
    if (compactMessage && scheduleCompactTurn) {
      logger.debug(`[${logTag}] A2A compact command peek: scheduling compression for message ${compactMessage.id}`);
      session.markA2AMessageRead(compactMessage.id);
      scheduleCompactTurn(getMode());
      return;
    }
    logger.debug(`[${logTag}] A2A inbox peek: scheduling turn for ${unreadCount} unread message(s)`);
    messageQueue.pushIsolated('', { ...getMode() }, A2A_INBOX_TURN_META);
  };

  return {
    isInboxTurnMeta: isA2AInboxTurnMeta,
    setInboxTurnActive: (active: boolean) => {
      if (active) {
        inboxMcpScopeStack.push('inbox-turn');
      } else {
        const remaining = inboxMcpScopeStack.popAll('inbox-task');
        if (remaining > 0) {
          logger.debug(`[${logTag}] A2A inbox turn end: cleared ${remaining} stale inbox-task MCP scope(s)`);
        }
        if (!inboxMcpScopeStack.pop('inbox-turn')) {
          logger.debug(`[${logTag}] A2A inbox turn end: inbox-turn scope was not on MCP stack`);
        }
      }
    },
    isInboxTurnActive: () => inboxMcpScopeStack.hasScope('inbox-turn'),
    isInboxMcpAllowed: () => inboxMcpScopeStack.isAllowed(),
    describeInboxMcpScope: () => inboxMcpScopeStack.describe(),
    prepareInboxTurnPrompt: () => {
      a2aTurnQueued = false;
      const inbox = session.getA2AInbox();
      if (!hasUnreadA2AInboxMessages(inbox)) {
        logger.debug(`[${logTag}] A2A inbox turn dequeued with no inbox work; skipping`);
        return null;
      }
      const turnId = createId();
      const unreadCount = getA2AUnreadCount(inbox);
      const snapshotPath = writeA2AInboxSnapshot(workspacePath, sessionId, turnId, inbox);
      const summary = buildA2AInboxNotificationWithPreview(inbox);
      return buildTurnPrompt(summary, snapshotPath, unreadCount);
    },
    onTurnEnd: ({ succeeded, cancelled, wasInboxTurn }) => {
      if (wasInboxTurn) {
        if (succeeded) {
          if (isA2AInboxTurnConsumed(session.getA2AInbox())) {
            clearA2AInboxBackoff();
            logger.debug(`[${logTag}] A2A inbox turn succeeded; backoff reset`);
          } else {
            a2aInboxBackoffStreak += 1;
            const delayMs = a2aInboxBackoffDelayMs(a2aInboxBackoffStreak, a2aInboxBackoffSettings);
            a2aInboxBackoffUntil = Date.now() + delayMs;
            logger.debug(
              `[${logTag}] A2A inbox turn finished but unread messages remain; `
              + `backing off ${delayMs}ms (streak ${a2aInboxBackoffStreak})`,
            );
            scheduleA2AInboxRetryPeek(delayMs);
            if (a2aInboxBackoffStreak >= 4) {
              const unread = listA2AInboxMessages(session.getA2AInbox(), { unreadOnly: true });
              if (unread.length > 0) {
                session.markA2AMessagesRead(unread.map((m) => m.id));
                logger.debug(
                  `[${logTag}] Force-cleared ${unread.length} local A2A unread after ${a2aInboxBackoffStreak} repeated drain failures`,
                );
                clearA2AInboxBackoff();
              }
            }
          }
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
