/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /** Workspace directory the session was spawned in */
  directory?: string;
  /** Happy server session tag (UUID) for reconnecting to the same server session */
  sessionTag?: string;
  /** Agent type used when spawning */
  agent?: 'claude' | 'codex' | 'cursor' | 'gemini';
  /** Timestamp of last heartbeat received from this session (Date.now()) */
  lastHeartbeat?: number;
}