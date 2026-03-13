/**
 * Cursor Transport Handler
 *
 * cursor-agent ACP mode implementation of TransportHandler.
 * cursor-agent acp speaks standard JSON-RPC 2.0 over stdio and starts quickly.
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
} from '../TransportHandler';

const CURSOR_TIMEOUTS = {
  /** cursor-agent acp starts in ~1s */
  init: 10_000,
  /** Standard tool call timeout (10 min for long builds) */
  toolCall: 600_000,
  /** Idle detection after last message chunk */
  idle: 1_000,
} as const;

export class CursorTransport implements TransportHandler {
  readonly agentName = 'cursor';

  getInitTimeout(): number {
    return CURSOR_TIMEOUTS.init;
  }

  getIdleTimeout(): number {
    return CURSOR_TIMEOUTS.idle;
  }

  getToolPatterns(): ToolPattern[] {
    return [];
  }

  getToolCallTimeout(_toolCallId: string, _toolKind?: string): number {
    return CURSOR_TIMEOUTS.toolCall;
  }

  handleStderr(_text: string, _context: StderrContext): StderrResult {
    // cursor-agent writes logs to stderr; suppress from UI
    return { message: null };
  }
}

export const cursorTransport = new CursorTransport();
