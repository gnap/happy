import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { AgentMessage } from '@/agent/core';
import { logger } from '@/ui/logger';

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function formatToolResult(toolName: string, result: unknown): Record<string, unknown> | string | undefined {
  if (result === null || result === undefined) return undefined;
  if (typeof result !== 'object' || Array.isArray(result)) return undefined;
  const r = result as Record<string, unknown>;
  if (toolName === 'execute') {
    const stdout = typeof r['stdout'] === 'string' ? r['stdout'].trim() : '';
    const stderr = typeof r['stderr'] === 'string' ? r['stderr'].trim() : '';
    const exitCode = r['exitCode'];
    if (exitCode !== 0 && stderr) return `exit ${exitCode}\n${stderr}`;
    if (exitCode !== 0) return `exit ${exitCode}`;
    return stdout || undefined;
  }
  if (toolName === 'read') {
    const content = typeof r['content'] === 'string' ? r['content'].trim() : '';
    return content || undefined;
  }
  if (toolName === 'search') {
    const totalMatches = r['totalMatches'];
    return totalMatches !== undefined ? { totalMatches } : undefined;
  }
  return r;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}


export class AcpSessionManager {
  private readonly agentName: string;
  private currentTurnId: string | null = null;
  private readonly acpCallToSessionCall = new Map<string, string>();

  constructor(agentName: string) {
    this.agentName = agentName;
  }

  /** Monotonic clock: max(lastTime + 1, Date.now()) */
  private lastTime = 0;

  /** Pending text waiting to be flushed when the stream type changes */
  private pendingText = '';
  private pendingType: 'thinking' | 'output' | null = null;

  private nextTime(): number {
    this.lastTime = Math.max(this.lastTime + 1, Date.now());
    return this.lastTime;
  }

  private ensureSessionCallId(acpCallId: string): string {
    const existing = this.acpCallToSessionCall.get(acpCallId);
    if (existing) {
      return existing;
    }

    const created = createId();
    this.acpCallToSessionCall.set(acpCallId, created);
    return created;
  }

  private flush(): SessionEnvelope[] {
    if (!this.pendingText || !this.pendingType) {
      return [];
    }
    const text = this.pendingText.replace(/^\n+|\n+$/g, '');
    const type = this.pendingType;
    this.pendingText = '';
    this.pendingType = null;

    if (!text) {
      return [];
    }
    if (type === 'thinking') {
      return [createEnvelope('agent', { t: 'text', text, thinking: true }, turnOptions(this.currentTurnId, this.nextTime()))];
    }
    return [createEnvelope('agent', { t: 'text', text }, turnOptions(this.currentTurnId, this.nextTime()))];
  }

  /**
   * Flush accumulated output text as a single envelope.
   * Called periodically by the runner (e.g. every 80ms) so the app receives
   * batched chunks instead of one envelope per token.
   */
  flushText(): SessionEnvelope[] {
    if (this.pendingType !== 'output') {
      return [];
    }
    return this.flush();
  }

  startTurn(): SessionEnvelope[] {
    if (this.currentTurnId) {
      return [];
    }

    this.currentTurnId = createId();
    this.acpCallToSessionCall.clear();
    return [
      createEnvelope('agent', { t: 'turn-start' }, { turn: this.currentTurnId, time: this.nextTime() }),
    ];
  }

  endTurn(status: 'completed' | 'failed' | 'cancelled'): SessionEnvelope[] {
    const flushed = this.flush();
    if (!this.currentTurnId) {
      return flushed;
    }

    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    this.acpCallToSessionCall.clear();
    return [
      ...flushed,
      createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId, time: this.nextTime() }),
    ];
  }

  mapMessage(msg: AgentMessage): SessionEnvelope[] {
    if (msg.type === 'event' && msg.name === 'thinking') {
      if (this.agentName === 'cursor') {
        return [];
      }
      const payload = msg.payload as { text?: string; streaming?: boolean } | string | null;
      const text = typeof payload === 'string' ? payload : (payload as { text?: string })?.text ?? '';
      const streaming = typeof payload === 'object' && payload !== null && (payload as { streaming?: boolean }).streaming === true;
      const trimmed = text.replace(/^\n+|\n+$/g, '');
      if (!trimmed) {
        return streaming ? [] : this.flush();
      }
      if (streaming) {
        const flushed = this.pendingType !== 'thinking' ? this.flush() : [];
        this.pendingType = 'thinking';
        this.pendingText += trimmed;
        return flushed;
      }
      return [
        ...this.flush(),
        createEnvelope('agent', { t: 'text', text: trimmed, thinking: true }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'status') {
      return [];
    }

    if (msg.type === 'model-output') {
      const text = msg.textDelta ?? '';
      if (!text) {
        return [];
      }
      // Flush pending if switching from a different type (e.g. thinking → output)
      const flushed = this.pendingType !== 'output' ? this.flush() : [];
      this.pendingType = 'output';
      // Accumulate instead of emitting per-token; caller flushes periodically via flushText()
      this.pendingText += text;
      return flushed;
    }

    if (msg.type === 'tool-call') {
      const flushed = this.flush();
      const call = this.ensureSessionCallId(msg.callId);
      return [
        ...flushed,
        createEnvelope('agent', {
          t: 'tool-call-start',
          call,
          name: msg.toolName,
          title: buildToolTitle(msg.toolName),
          description: buildToolDescription(msg.toolName),
          args: msg.args,
        }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'tool-result') {
      const flushed = this.flush();
      const call = this.ensureSessionCallId(msg.callId);
      const result = formatToolResult(msg.toolName, msg.result);
      return [
        ...flushed,
        createEnvelope('agent', { t: 'tool-call-end', call, ...(result !== undefined ? { result } : {}) }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    return [];
  }
}
