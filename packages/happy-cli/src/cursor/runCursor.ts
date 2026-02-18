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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { configuration } from '@/configuration';

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
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';

/**
 * Use native codex message format (type: 'codex') instead of ACP format
 * because the mobile app has dedicated handling for codex messages.
 */

import { createEnvelope } from '@slopus/happy-wire';
import { createId } from '@paralleldrive/cuid2';
import { CursorProcess } from './cursorProcess';
import { CursorMessageParser, type CursorParsedMessage } from './cursorMessageParser';
import type { CursorStreamMessage, CursorMode } from './types';

const CURSOR_SESSION_TAG_FILE = 'cursor-session-tag';

/**
 * Map Cursor tool name/args to Codex/app shape so the mobile app shows readable titles
 * instead of a raw object (e.g. CodexBash → "$ command", Read → file path).
 */
function toCodexToolShape(
  toolName: string,
  args: Record<string, unknown>,
): { codexName: string; codexInput: Record<string, unknown> } {
  if (toolName === 'CursorBash') {
    const cmd =
      typeof args?.command === 'string'
        ? args.command
        : Array.isArray(args?.command)
          ? (args.command as string[]).join(' ')
          : '';
    return {
      codexName: 'CodexBash',
      codexInput: {
        command: [cmd],
        parsed_cmd: [{ type: 'bash', cmd }],
      },
    };
  }
  if (toolName === 'CursorRead') {
    const path = (args?.path ?? args?.file_path) as string | undefined;
    return {
      codexName: 'Read',
      codexInput: { file_path: path ?? '' },
    };
  }
  if (toolName === 'CursorWrite') {
    const path = (args?.path ?? args?.file_path) as string | undefined;
    const content = (args?.content as string) ?? '';
    return {
      codexName: 'Write',
      codexInput: { file_path: path ?? '', content },
    };
  }
  if (toolName === 'CursorEdit') {
    const file_path = (args?.path ?? args?.file_path ?? args?.filePath) as string | undefined;
    const old_string = (args?.old_string ?? args?.oldString ?? args?.oldText) as string | undefined;
    const new_string = (args?.new_string ?? args?.newString ?? args?.newText) as string | undefined;
    return {
      codexName: 'Edit',
      codexInput: { file_path: file_path ?? '', old_string: old_string ?? '', new_string: new_string ?? '' },
    };
  }
  return { codexName: toolName, codexInput: args };
}

/**
 * Main entry point for the cursor command with ink UI.
 */
export async function runCursor(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
}): Promise<void> {

  // Reuse last session tag so restart reconnects to the same session (set HAPPY_CURSOR_NEW_SESSION=1 for a new one)
  const tagPath = join(configuration.happyHomeDir, CURSOR_SESSION_TAG_FILE);
  let sessionTag: string;
  if (process.env.HAPPY_CURSOR_NEW_SESSION === '1') {
    sessionTag = randomUUID();
  } else if (existsSync(tagPath)) {
    try {
      sessionTag = readFileSync(tagPath, 'utf8').trim() || randomUUID();
    } catch {
      sessionTag = randomUUID();
    }
  } else {
    sessionTag = randomUUID();
  }

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

  const tagReused = existsSync(tagPath) && process.env.HAPPY_CURSOR_NEW_SESSION !== '1';
  const sessionId = response?.id ?? `offline-${sessionTag}`;
  logger.debug(`[cursor] Session: ${sessionId} (tag: ${sessionTag.slice(0, 8)}..., reused: ${tagReused})`);
  if (tagReused) {
    logger.debug('[cursor] Reusing session – open this same conversation in the app (or tap "It\'s ready!" push) so CLI and phone stay in sync.');
  }

  // Persist session tag so next restart reuses this session
  try {
    writeFileSync(tagPath, sessionTag, 'utf8');
  } catch (e) {
    logger.debug('[cursor] Could not write session tag file:', e);
  }

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

      // Cursor has no change_title MCP tool, so don't append that instruction (unlike Codex/Gemini)
      const prompt = userMessage;

      // Accumulated response text for final message to mobile
      let accumulatedResponse = '';
      let hadToolCalls = false;
      const turnId = createId();
      const messageParser = new CursorMessageParser();
      // Codex messages have both callId and id; app may match by id to stop timer
      const codexIdByCallId = new Map<string, string>();

      try {
        thinking = true;
        session.keepAlive(thinking, 'remote');

        // Send task_started (codex) and turn-start (session protocol) so mobile starts timer
        session.sendCodexMessage( {
          type: 'task_started',
          id: randomUUID(),
        });
        session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
        messageBuffer.addMessage('Thinking...', 'system');

        // Spawn cursor-agent process (second+ turn uses --resume so cursor-agent continues same chat)
        const cursorModel = process.env.CURSOR_MODEL || 'auto';
        const resumeId = cursorChatId || undefined;
        if (resumeId) {
          logger.debug(`[cursor] Resuming chat: ${resumeId}`);
        } else {
          logger.debug('[cursor] First turn, no resume');
        }
        const cursorProc = new CursorProcess({
          cwd: process.cwd(),
          resumeChatId: resumeId,
          model: cursorModel,
          signal: abortController.signal,
          timeoutMs: 300000,
        });

        // Handle stream-json messages
        cursorProc.on('message', (rawMsg: CursorStreamMessage) => {
          logger.debug(`[cursor] Raw message: ${JSON.stringify(rawMsg).slice(0, 200)}`);

          const parsed = messageParser.parse(rawMsg);
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
              const { codexName, codexInput } = toCodexToolShape(msg.toolName, msg.args);
              const codexId = randomUUID();
              codexIdByCallId.set(msg.callId, codexId);
              session.sendCodexMessage( {
                type: 'tool-call',
                name: codexName,
                callId: msg.callId,
                input: codexInput,
                id: codexId,
              });
              // Session protocol: timer uses tool-call-start / tool-call-end to stop
              const cmd = Array.isArray((codexInput as { command?: unknown })?.command)
                ? (codexInput as { command: string[] }).command.join(' ')
                : (codexInput as { command?: string })?.command ?? '';
              const toolTitle = cmd ? `Run \`${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}\`` : `${codexName} call`;
              session.sendSessionProtocolMessage(createEnvelope('agent', {
                t: 'tool-call-start',
                call: msg.callId,
                name: codexName,
                title: toolTitle,
                description: toolTitle,
                args: codexInput,
              }, { turn: turnId }));
              break;

            case 'tool_call_end':
              const resultText = typeof msg.result === 'string'
                ? msg.result.slice(0, 200)
                : JSON.stringify(msg.result).slice(0, 200);
              messageBuffer.addMessage(
                msg.success ? `Result: ${resultText}` : `Error: ${resultText}`,
                'result',
              );
              const sameId = codexIdByCallId.get(msg.callId) ?? randomUUID();
              codexIdByCallId.delete(msg.callId);
              session.sendCodexMessage( {
                type: 'tool-call-result',
                callId: msg.callId,
                output: msg.result,
                id: sameId,
              });
              session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: msg.callId }, { turn: turnId }));
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
          session.sendCodexMessage({ type: 'message', message: 'Aborted by user' });
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

        // Send task_complete (codex) and turn-end (session protocol) so mobile stops timer
        session.sendCodexMessage( {
          type: 'task_complete',
          id: randomUUID(),
        });
        session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: turnId }));

        await session.flush();

        // Clear parser state for next turn
        messageParser.clear();

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
