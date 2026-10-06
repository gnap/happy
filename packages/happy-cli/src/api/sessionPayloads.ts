/**
 * Wire payloads for the records the CLI sends to a session.
 *
 * These were previously inline in `ApiSessionClient`'s send methods. They are pure
 * functions so the offline session -- which encrypts and queues messages itself, without
 * a connection -- can produce byte-identical records instead of duplicating the shapes
 * and drifting from them.
 *
 * Only the record construction lives here. Everything stateful (lazy tool-content
 * encoding, writer identity stamping, tracing, encryption, queueing) stays in the client.
 */

import type { SessionEnvelope } from '@slopus/happy-wire';
import type { ACPMessageData, ACPProvider, OutputFormatData } from './apiSession';

export type SessionEventPayload =
  | { type: 'switch'; mode: 'local' | 'remote' }
  | { type: 'message'; message: string }
  | { type: 'permission-mode-changed'; mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' }
  | { type: 'ready' };

export type SessionRecord = {
  role: 'agent' | 'session';
  content: unknown;
  meta?: Record<string, unknown>;
};

export function buildCodexPayload(body: unknown): SessionRecord {
  return {
    role: 'agent',
    content: { type: 'codex', data: body },
    meta: { sentFrom: 'cli' },
  };
}

/** Same shape as codex but type 'cursor', so the app normalizes thinking as thinking. */
export function buildCursorPayload(body: unknown): SessionRecord {
  return {
    role: 'agent',
    content: { type: 'cursor', data: body },
    meta: { sentFrom: 'cli' },
  };
}

/** Legacy Claude "output" format, dual-sent for old App compatibility. */
export function buildOutputFormatPayload(data: OutputFormatData): SessionRecord {
  return {
    role: 'agent',
    content: { type: 'output', data },
    meta: { sentFrom: 'cli' },
  };
}

export function buildSessionProtocolPayload(
  envelope: SessionEnvelope,
  extraMeta?: Record<string, unknown>,
): SessionRecord {
  return {
    role: 'session',
    content: envelope,
    meta: { sentFrom: 'cli', ...(extraMeta ?? {}) },
  };
}

/**
 * Lifecycle envelopes are wrapped as `content.data` because that is the shape the App
 * expects for its thinking timer (`content.content.data.ev.t`). Other session messages
 * keep the flat shape above.
 */
export function buildLifecyclePayload(envelope: SessionEnvelope): SessionRecord {
  return {
    role: 'session',
    content: { type: 'session', data: envelope },
    meta: { sentFrom: 'cli' },
  };
}

export function buildAgentMessagePayload(provider: ACPProvider, body: ACPMessageData): SessionRecord {
  return {
    role: 'agent',
    content: { type: 'acp', provider, data: body },
    meta: { sentFrom: 'cli' },
  };
}

/** Note: no `meta` -- this is the one record shape that carries none. */
export function buildSessionEventPayload(id: string, event: SessionEventPayload): SessionRecord {
  return {
    role: 'agent',
    content: { id, type: 'event', data: event },
  };
}
