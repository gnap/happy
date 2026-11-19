/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';
import type { SandboxConfig } from '@/persistence';

/**
 * What `archiveSession` did, rather than whether it "succeeded".
 *
 * A deletion is a fact written to this machine's log, so it has an outcome even when the machine
 * never held the row: the tombstone is applied, `known` is false, and the server replay consumes
 * it by id. Separating the two is what stops an unknown session from being reported as a failure
 * (and then silently doing nothing, which is how the server kept a row the App had deleted).
 */
export type ArchiveSessionResult = {
    /** The tombstone is in the log. Anything else means the caller has to retry or ask another road. */
    applied: boolean;
    /** This machine had a row for the session before the tombstone. */
    known: boolean;
    /** The CLI's tag, when this machine knew it. */
    tag?: string;
};

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
  /**
   * Spawned by Happy Sidecar inside the user's desktop session, because the session needs the
   * login keychain or another desktop-only facility. Such a session cannot start before a user
   * logs in, and the roster says so.
   */
  requiresDesktop?: boolean;
  /** Timestamp of last heartbeat received from this session (Date.now()) */
  lastHeartbeat?: number;
  /** Timestamp when the session process was spawned (Date.now()) */
  spawnTime?: number;
  /** Per-session sandbox config, preserved for stopped sessions so respawns reuse it */
  sandbox?: SandboxConfig | null;
  /** Transient systemd scope the session runs in (Linux scope mode only). */
  scopeUnit?: string;

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