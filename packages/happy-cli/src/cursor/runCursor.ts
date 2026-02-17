/**
 * Cursor Agent CLI Entry Point
 *
 * Main entry point for running the Cursor agent through Happy CLI.
 * Follows the same architecture as runCodex/runGemini:
 * - Session management via Happy server
 * - Message queue for user prompts from mobile/web
 * - PTY-wrapped cursor-agent process per turn
 * - Stream-json output parsed into session protocol envelopes
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';

/**
 * Use native codex message format (type: 'codex') instead of ACP format
 * because the mobile app has dedicated handling for codex messages.
 */

import { CursorProcess } from './cursorProcess';
import { parseCursorMessage, type CursorParsedMessage } from './cursorMessageParser';
import { mapCursorMessageToSessionEnvelopes, type CursorTurnState } from './sessionProtocolMapper';
import type { CursorStreamMessage } from './types';

interface CursorMode {
  permissionMode: PermissionMode;
}

/**
 * Main entry point for the cursor command with ink UI.
 */
export async function runCursor(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
}): Promise<void> {

  const sessionTag = randomUUID();

  // Set backend for offline warnings
  connectionState.setBackend('Cursor');

  const api = await ApiClient.create(opts.credentials);

  //
  // Machine
  //

  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(`[START] No machine ID found. Run "happy auth login" first.`);
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata,
  });

  //
  // Create session
  //

  const { state, metadata } = createSessionMetadata({
    flavor: 'codex', // Disguised as codex until mobile app supports 'cursor'
    machineId,
    startedBy: opts.startedBy,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  // Handle server unreachable - offline stub with hot reconnection
  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    },
  });
  session = initialSession;

  // Report to daemon
  if (response) {
    try {
      logger.debug(`[START] Reporting session ${response.id} to daemon`);
      const result = await notifyDaemonSessionStarted(response.id, metadata);
      if (result.error) {
        logger.debug(`[START] Failed to report to daemon:`, result.error);
      }
    } catch (error) {
      logger.debug('[START] Failed to report to daemon:', error);
    }
  }

  //
  // Message queue
  //

  const messageQueue = new MessageQueue2<CursorMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
  }));

  let currentPermissionMode: PermissionMode | undefined = undefined;

  session.onUserMessage((message) => {
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
      if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
        messagePermissionMode = message.meta.permissionMode as PermissionMode;
        currentPermissionMode = messagePermissionMode;
        logger.debug(`[Cursor] Permission mode: ${currentPermissionMode}`);
      }
    }
    if (currentPermissionMode === undefined) {
      currentPermissionMode = 'default';
    }

    const mode: CursorMode = {
      permissionMode: messagePermissionMode || 'default',
    };
    messageQueue.push(message.content.text, mode);
  });

  //
  // Keep-alive
  //

  let thinking = false;
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  let isFirstMessage = true;

  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices(
        "It's ready!",
        'Cursor is waiting for your command',
        { sessionId: session.sessionId },
      );
    } catch (pushError) {
      logger.debug('[Cursor] Failed to send ready push', pushError);
    }
  };

  const emitReadyIfIdle = (): boolean => {
    if (shouldExit) return false;
    if (thinking) return false;
    if (messageQueue.size() > 0) return false;
    sendReady();
    return true;
  };

  //
  // Abort handling
  //

  let abortController = new AbortController();
  let shouldExit = false;
  let cursorChatId: string | null = null;

  async function handleAbort() {
    logger.debug('[Cursor] Abort requested');
    session.sendCodexMessage( {
      type: 'turn_aborted',
      id: randomUUID(),
    });
    try {
      abortController.abort();
      messageQueue.reset();
    } catch (error) {
      logger.debug('[Cursor] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[Cursor] Kill session requested');
    await handleAbort();

    try {
      if (session) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated',
        }));
        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }
      stopCaffeinate();
      happyServer.stop();
      process.exit(0);
    } catch (error) {
      logger.debug('[Cursor] Error during session termination:', error);
      process.exit(1);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  //
  // Initialize Ink UI (reuse CodexDisplay since layout is similar)
  //

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;

  if (hasTTY) {
    console.clear();
    inkInstance = render(React.createElement(CodexDisplay, {
      messageBuffer,
      logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
      onExit: async () => {
        logger.debug('[cursor]: Exiting agent via Ctrl-C');
        shouldExit = true;
        await handleAbort();
      },
    }), {
      exitOnCtrlC: false,
      patchConsole: false,
    });
  }

  if (hasTTY) {
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  //
  // Start Happy MCP server
  //

  const happyServer = await startHappyServer(session);

  //
  // Session protocol state
  //

  let turnState: CursorTurnState = { currentTurnId: null };

  //
  // Main loop
  //

  let first = true;

  try {
    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (waitSignal.aborted && !shouldExit) {
          logger.debug('[cursor] Wait aborted while idle, continuing');
          continue;
        }
        break;
      }

      const { message: userMessage, mode } = batch;
      messageBuffer.addMessage(userMessage, 'user');
      logger.debug(`[cursor] Received message (length: ${userMessage.length})`);

      // Build the prompt
      let prompt = userMessage;
      if (first && isFirstMessage) {
        // Append change_title instruction on first message (like Codex/Gemini)
        prompt = userMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
        isFirstMessage = false;
      }

      // Accumulated response text for final message to mobile
      let accumulatedResponse = '';
      let hadToolCalls = false;

      try {
        thinking = true;
        session.keepAlive(thinking, 'remote');

        // Send task_started (ACP only, like Gemini)
        session.sendCodexMessage( {
          type: 'task_started',
          id: randomUUID(),
        });
        messageBuffer.addMessage('Thinking...', 'system');

        // Spawn cursor-agent process
        const cursorModel = process.env.CURSOR_MODEL || 'auto';
        const cursorProc = new CursorProcess({
          cwd: process.cwd(),
          resumeChatId: cursorChatId || undefined,
          model: cursorModel,
          signal: abortController.signal,
          timeoutMs: 300000,
        });

        // Handle stream-json messages
        cursorProc.on('message', (rawMsg: CursorStreamMessage) => {
          logger.debug(`[cursor] Raw message: ${JSON.stringify(rawMsg).slice(0, 200)}`);

          const parsed = parseCursorMessage(rawMsg);
          for (const msg of parsed) {
            handleParsedMessage(msg);
          }
        });

        function handleParsedMessage(msg: CursorParsedMessage) {
          switch (msg.type) {
            case 'session_init':
              if (msg.sessionId) {
                cursorChatId = msg.sessionId;
                logger.debug(`[cursor] Chat ID: ${cursorChatId}`);
              }
              break;

            case 'text_delta':
              accumulatedResponse += msg.text;
              messageBuffer.removeLastMessage('system');
              messageBuffer.addMessage(msg.text, 'assistant');
              // Text is accumulated and sent as one ACP message in finally block
              break;

            case 'thinking_delta':
              messageBuffer.updateLastMessage(`[Thinking] ${msg.text.slice(0, 100)}...`, 'system');
              session.sendCodexMessage( {
                type: 'thinking',
                text: msg.text,
              });
              break;

            case 'tool_call_start':
              hadToolCalls = true;
              const toolArgs = JSON.stringify(msg.args).slice(0, 100);
              messageBuffer.addMessage(`Executing: ${msg.toolName} ${toolArgs}`, 'tool');
              session.sendCodexMessage( {
                type: 'tool-call',
                name: msg.toolName,
                callId: msg.callId,
                input: msg.args,
                id: randomUUID(),
              });
              break;

            case 'tool_call_end':
              const resultText = typeof msg.result === 'string'
                ? msg.result.slice(0, 200)
                : JSON.stringify(msg.result).slice(0, 200);
              messageBuffer.addMessage(
                msg.success ? `Result: ${resultText}` : `Error: ${resultText}`,
                'result',
              );
              session.sendCodexMessage( {
                type: 'tool-result',
                callId: msg.callId,
                output: msg.result,
                id: randomUUID(),
              });
              break;

            case 'task_complete':
              // Only record metadata here; turn-end envelope is sent in finally block
              if (msg.sessionId) {
                cursorChatId = msg.sessionId;
              }
              if (msg.costUsd !== undefined) {
                logger.debug(`[cursor] Cost: $${msg.costUsd}, Duration: ${msg.durationMs}ms`);
              }
              // Do NOT send turn-end here - it's handled in the finally block
              break;

            case 'error':
              messageBuffer.addMessage(`Error: ${msg.message}`, 'status');
              session.sendCodexMessage( {
                type: 'message',
                message: `Error: ${msg.message}`,
              });
              break;
          }
        }

        // Run the process (blocks until exit)
        await cursorProc.run(prompt);

        first = false;

      } catch (error) {
        const isAbortError = error instanceof Error && error.name === 'AbortError';
        if (isAbortError) {
          messageBuffer.addMessage('Aborted by user', 'status');
          session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        } else {
          const errorMsg = error instanceof Error ? error.message : 'Process error';
          logger.debug('[cursor] Error:', error);
          messageBuffer.addMessage(errorMsg, 'status');
          session.sendCodexMessage( {
            type: 'message',
            message: errorMsg,
          });
        }
      } finally {
        // Send accumulated response to mobile
        if (accumulatedResponse.trim()) {
          session.sendCodexMessage( {
            type: 'message',
            message: accumulatedResponse,
          });
        }

        // Send task_complete (ACP only, like Gemini)
        session.sendCodexMessage( {
          type: 'task_complete',
          id: randomUUID(),
        });

        thinking = false;
        session.keepAlive(thinking, 'remote');
        emitReadyIfIdle();

        logger.debug(`[cursor] Turn completed (queue: ${messageQueue.size()})`);
      }
    }

  } finally {
    // Cleanup
    logger.debug('[cursor]: Final cleanup start');

    if (reconnectionHandle) {
      reconnectionHandle.cancel();
    }

    try {
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (e) {
      logger.debug('[cursor]: Error closing session', e);
    }

    happyServer.stop();

    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    if (hasTTY) {
      try { process.stdin.pause(); } catch { /* ignore */ }
    }

    clearInterval(keepAliveInterval);
    if (inkInstance) {
      inkInstance.unmount();
    }
    messageBuffer.clear();

    logger.debug('[cursor]: Final cleanup completed');
  }
}
