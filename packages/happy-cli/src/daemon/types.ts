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
  agent?: 'claude' | 'codex' | 'cursor' | 'cursor-acp' | 'acp-cursor' | 'gemini';
  /** Timestamp of last heartbeat received from this session (Date.now()) */
  lastHeartbeat?: number;
  /** Timestamp when the session process was spawned (Date.now()) */
  spawnTime?: number;

  // --- Exit tracking ---
  /** Process exit code (0 = normal, non-zero = error, null = killed by signal) */
  exitCode?: number | null;
  /** Signal that terminated the process (e.g. 'SIGTERM', 'SIGKILL') */
  exitSignal?: string | null;
  /** Timestamp when exit was detected (Date.now()) */
  exitTime?: number;
  /**
   * Human-readable exit reason. Sources (in priority order):
   *   1. Session process called /session-ending webhook before dying
   *   2. Daemon captured exit code/signal from child process exit event
   *   3. Daemon PID check found process gone ('evicted (pid missing)')
   */
  exitReason?: string;
  /**
   * Set to true when session-ending is called with archive=true (app-initiated kill).
   * When true, the session is NOT moved to stoppedSessions on exit — it disappears from the list.
   */
  pendingArchive?: boolean;
}