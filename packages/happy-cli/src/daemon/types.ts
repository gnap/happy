/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';
import type { SandboxConfig } from '@/persistence';
import type { SessionPhase } from './sessionStatus';

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
 * How far a control request has got, as the machine can honestly say.
 *
 * `success` answers "do I need to retry this on another road"; the stage answers "what actually
 * happened". They are different questions, and collapsing them is what made an accepted restart
 * indistinguishable from a finished one — the caller had a boolean, so it had to be one or the
 * other, and whichever it was, some caller read it wrong.
 */
export type SessionControlStage =
    /** Recorded as the machine's desired state; the work has not finished. */
    | 'scheduled'
    /** A process exists but has not registered yet. */
    | 'starting'
    /** The work finished and the session is up. */
    | 'running'
    /** The work finished, without a session process being the outcome (e.g. a deletion). */
    | 'done'
    /** The machine declined before doing anything. */
    | 'refused'
    /** The machine tried and the attempt failed. */
    | 'failed';

export type SessionControlResult = {
    /** Legacy field: the machine took responsibility for the request. */
    success: boolean;
    /** The explicit form of the same fact, alongside the stage rather than replacing it. */
    accepted: boolean;
    stage: SessionControlStage;
    /**
     * The session or tag the result is about: the new id when one exists, the existing id or tag
     * otherwise. Neutral because a create that only reached `scheduled` may have no server id yet
     * — that is the whole point of answering early.
     */
    ref?: string;
    generation?: number;
    phase?: SessionPhase;
    reason?: string;
    message?: string;
};

/** What a restart attempt reports. `newSessionId` remains for callers that key on the new id. */
export type RestartSessionResult = SessionControlResult & {
    newSessionId?: string;
    error?: string;
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
  /**
   * The spec revision this tracked process is realizing.
   *
   * Carried on the process rather than only in the store so that a session still waiting for the
   * server — which has no store key yet — can still say which generation it belongs to.
   */
  generation?: number;
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