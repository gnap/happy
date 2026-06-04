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

/** Re-check interval after a backoff timer fires while the main agent is still busy. */
const A2A_INBOX_RETRY_REARM_MS = 5_000;

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
    // When the timer fires, the main agent may still be mid-turn (no waiter to wake,
    // and `onReady → peekInbox` only re-evaluates when the agent's result arrives —
    // which can be deferred indefinitely by SDK retries). Try scheduling directly so
    // the deferral is logged, and re-arm a short tick if the agent is still busy so
    // we don't silently drop the inbox turn.
    const tickRetry = () => {
      a2aInboxBackoffTimer = null;
      if (isAgentTurnActive() || inboxMcpScopeStack.hasScope('inbox-turn')) {
        a2aInboxBackoffTimer = setTimeout(tickRetry, A2A_INBOX_RETRY_REARM_MS);
        return;
      }
      scheduleA2ATurnIfNeeded();
    };
    a2aInboxBackoffTimer = setTimeout(tickRetry, delayMs);
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
    if (isAgentTurnActive() || inboxMcpScopeStack.hasScope('inbox-turn')) {
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
    const reconciled = session.reconcileLocalA2AInboxWithServerAgentState();
    if (reconciled > 0) {
      logger.debug(`[${logTag}] Reconciled ${reconciled} orphan local A2A unread (server unreadCount=0)`);
    }
    if (!session.shouldEnqueueA2AInboxTurn()) {
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
      session.reconcileLocalA2AInboxWithServerAgentState();
      if (!session.shouldEnqueueA2AInboxTurn()) {
        logger.debug(`[${logTag}] A2A inbox turn dequeued with no inbox work; skipping`);
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
        if (succeeded) {
          const remainingUnread = getA2AUnreadCount(session.getA2AInbox());
          if (isA2AInboxTurnConsumed(session.getA2AInbox())) {
            clearA2AInboxBackoff();
            logger.debug(`[${logTag}] A2A inbox turn succeeded; backoff reset`);
          } else {
            a2aInboxBackoffStreak += 1;
            const delayMs = a2aInboxBackoffDelayMs(a2aInboxBackoffStreak, a2aInboxBackoffSettings);
            a2aInboxBackoffUntil = Date.now() + delayMs;
            if (
              session.getServerA2AUnreadCount() === 0
              && a2aInboxBackoffStreak >= 4
            ) {
              const abandoned = session.abandonLocalA2AInboxWhenServerDrained();
              if (abandoned > 0) {
                logger.debug(
                  `[${logTag}] Abandoned ${abandoned} local A2A unread after repeated drain `
                  + 'failures while server unreadCount=0',
                );
                clearA2AInboxBackoff();
              }
            } else {
              logger.debug(
                `[${logTag}] A2A inbox turn finished but ${remainingUnread} unread message(s) remain; `
                + `backing off ${delayMs}ms (streak ${a2aInboxBackoffStreak})`,
              );
              scheduleA2AInboxRetryPeek(delayMs);
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
