import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readSettings, getActiveProfile, getEnvironmentVariables, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';

/** Time to wait for a spawned session to report via /session-started webhook before failing the spawn (Cursor cold start can exceed 30s). */
const SESSION_WEBHOOK_TIMEOUT_MS = 60_000;

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath()
};

// Get environment variables for a profile, filtered for agent compatibility
async function getProfileEnvironmentVariablesForAgent(
  profileId: string,
  agentType: 'claude' | 'codex' | 'gemini' | 'cursor' | 'cursor-acp' | 'acp-cursor'
): Promise<Record<string, string>> {
  try {
    const settings = await readSettings();
    const profile = settings.profiles.find(p => p.id === profileId);

    if (!profile) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not found`);
      return {};
    }

    // Check if profile is compatible with the agent
    if (!validateProfileForAgent(profile, agentType)) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not compatible with agent ${agentType}`);
      return {};
    }

    // Get environment variables from profile (new schema)
    const envVars = getProfileEnvironmentVariables(profile);

    logger.debug(`[DAEMON RUN] Loaded ${Object.keys(envVars).length} environment variables from profile ${profileId} for agent ${agentType}`);
    return envVars;
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to get profile environment variables:', error);
    return {};
  }
}

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Ring buffer of recently exited sessions for post-mortem queries (capped at 50)
    const MAX_RECENTLY_EXITED = 50;
    const recentlyExited: TrackedSession[] = [];
    const pushRecentlyExited = (session: TrackedSession) => {
      recentlyExited.push({ ...session, childProcess: undefined });
      if (recentlyExited.length > MAX_RECENTLY_EXITED) {
        recentlyExited.shift();
      }
    };

    /**
     * Sessions that have exited but have not been archived by the user.
     * Keyed by happySessionId. Shown in 'daemon list' alongside active sessions.
     */
    const stoppedSessions = new Map<string, TrackedSession>();

    // Helper functions
    const getCurrentChildren = (): TrackedSession[] => [
      ...Array.from(pidToTrackedSession.values()),
      ...Array.from(stoppedSessions.values()),
    ];
    const getRecentlyExited = () => [...recentlyExited];

    /** Persist session tag by directory so restart can reuse same server session after process/daemon restart. */
    let lastSessionTagByDirectory: Record<string, string> = {};
    /** Persist server session ID -> session tag for reliable resume regardless of how many sessions share a directory. */
    let lastSessionTagBySessionId: Record<string, string> = {};
    /** Persist server session ID -> directory so heartbeat polling can find the directory for sessions with new messages. */
    let lastDirectoryBySessionId: Record<string, string> = {};
    /** Persist server session ID -> agent type for correct agent selection on auto-respawn. */
    let lastAgentBySessionId: Record<string, string> = {};
    /** In-memory cooldown: session ID -> last spawn attempt timestamp. Prevents rapid re-spawn loops. */
    const lastSpawnAttemptBySessionId: Record<string, number> = {};
    /** Timestamp used as changedSince for next /v2/sessions poll. */
    let sessionPollSince = Date.now();
    /** True after first poll completes; first poll only records seq baselines without spawning. */
    let initialPollDone = false;
    /** Last known seq per session ID. Populated during polling. */
    const lastSeqBySessionId: Record<string, number> = {};
    const persistSessionTagBeforeRemove = (session: TrackedSession) => {
      if (session.directory && session.sessionTag) lastSessionTagByDirectory[session.directory] = session.sessionTag;
      if (session.happySessionId && session.sessionTag) lastSessionTagBySessionId[session.happySessionId] = session.sessionTag;
    };

    /** Derive human-readable exit reason from code/signal when no webhook reason was given. */
    const resolveExitReason = (code: number | null, signal: string | null | undefined): string => {
      if (signal) {
        if (signal === 'SIGKILL') return 'killed (SIGKILL — OOM or force kill)';
        if (signal === 'SIGTERM') return 'terminated (SIGTERM)';
        if (signal === 'SIGINT') return 'interrupted (SIGINT)';
        return `signal: ${signal}`;
      }
      if (code === 0) return 'completed normally (exit 0)';
      if (code !== null && code !== undefined) return `exited with error (code ${code})`;
      return 'unknown';
    };

    /** Called by /session-ending webhook: session process pre-announces its exit reason. */
    const onSessionEnding = (sessionId: string, pid: number, reason: string, exitCode?: number, archive?: boolean) => {
      const session = pidToTrackedSession.get(pid);
      if (session) {
        session.exitReason = reason;
        if (exitCode !== undefined) session.exitCode = exitCode;
        if (archive) session.pendingArchive = true;
        logger.debug(`[DAEMON RUN] Session ending (self-reported): ${sessionId} PID ${pid} reason="${reason}" archive=${archive ?? false}`);
      } else {
        // Process already evicted — still record for history if it matches a recently-exited entry
        const recent = recentlyExited.slice().reverse().find((s: TrackedSession) => s.pid === pid && s.happySessionId === sessionId);
        if (recent) {
          recent.exitReason = reason;
          if (exitCode !== undefined) recent.exitCode = exitCode;
          logger.debug(`[DAEMON RUN] Session ending (self-reported, already evicted): ${sessionId} PID ${pid} reason="${reason}"`);;
        }
      }
    };

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        if (sessionMetadata.sessionTag) {
          existingSession.sessionTag = sessionMetadata.sessionTag;
        }
        existingSession.lastHeartbeat = Date.now();
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // New session started externally (or re-registration after daemon restart)
        const trackedSession: TrackedSession = {
          startedBy: sessionMetadata.startedBy === 'daemon' ? 'daemon' : 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          pid,
          directory: sessionMetadata.path,
          sessionTag: sessionMetadata.sessionTag,
          agent: (sessionMetadata.flavor as TrackedSession['agent']) ?? 'cursor',
          lastHeartbeat: Date.now(),
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered session ${sessionId} (started by: ${trackedSession.startedBy})`);
      } else {
        // Existing external session: refresh heartbeat and fill in any missing fields
        existingSession.lastHeartbeat = Date.now();
        if (!existingSession.directory && sessionMetadata.path) existingSession.directory = sessionMetadata.path;
        if (!existingSession.sessionTag && sessionMetadata.sessionTag) existingSession.sessionTag = sessionMetadata.sessionTag;
        if (!existingSession.agent && sessionMetadata.flavor) existingSession.agent = sessionMetadata.flavor as TrackedSession['agent'];
      }
      const s = pidToTrackedSession.get(pid);
      if (s?.directory && s.sessionTag) lastSessionTagByDirectory[s.directory] = s.sessionTag;
      if (s?.happySessionId && s.sessionTag) lastSessionTagBySessionId[s.happySessionId] = s.sessionTag;
      if (s?.happySessionId && s.directory) lastDirectoryBySessionId[s.happySessionId] = s.directory;
      if (s?.happySessionId && s.agent) lastAgentBySessionId[s.happySessionId] = s.agent;
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true, resumeSessionTag: explicitResumeSessionTag } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Build environment variables with explicit precedence layers:
        // Layer 1 (base): Authentication tokens - protected, cannot be overridden
        // Layer 2 (middle): Profile environment variables - GUI profile OR CLI local profile
        // Layer 3 (top): Auth tokens again to ensure they're never overridden

        // Layer 1: Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            authEnv.CODEX_HOME = codexHomeDir.name;
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        // Layer 2: Profile environment variables
        // Priority: GUI-provided profile > CLI local active profile > none
        let profileEnv: Record<string, string> = {};

        if (options.environmentVariables && Object.keys(options.environmentVariables).length > 0) {
          // GUI provided profile environment variables - highest priority for profile settings
          profileEnv = options.environmentVariables;
          logger.info(`[DAEMON RUN] Using GUI-provided profile environment variables (${Object.keys(profileEnv).length} vars)`);
          logger.debug(`[DAEMON RUN] GUI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
        } else {
          // Fallback to CLI local active profile
          try {
            const settings = await readSettings();
            if (settings.activeProfileId) {
              logger.debug(`[DAEMON RUN] No GUI profile provided, loading CLI local active profile: ${settings.activeProfileId}`);

              // Get profile environment variables filtered for agent compatibility
              profileEnv = await getProfileEnvironmentVariablesForAgent(
                settings.activeProfileId,
                options.agent || 'claude'
              );

              logger.debug(`[DAEMON RUN] Loaded ${Object.keys(profileEnv).length} environment variables from CLI local profile for agent ${options.agent || 'claude'}`);
              logger.debug(`[DAEMON RUN] CLI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
            } else {
              logger.debug('[DAEMON RUN] No CLI local active profile set');
            }
          } catch (error) {
            logger.debug('[DAEMON RUN] Failed to load CLI local profile environment variables:', error);
            // Continue without profile env vars - this is not a fatal error
          }
        }

        // Final merge: Profile vars first, then auth (auth takes precedence to protect authentication)
        let extraEnv = { ...profileEnv, ...authEnv };
        logger.debug(`[DAEMON RUN] Final environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from daemon's process.env
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        const resumeSessionTag =
          explicitResumeSessionTag?.trim() ||
          (sessionId ? (lastSessionTagBySessionId[sessionId] ?? lastSessionTagByDirectory[directory]) : undefined);
        const shouldPassResumeSessionTag = options.agent === 'cursor' || options.agent === 'cursor-acp' || options.agent === 'acp-cursor';

        // Fail-fast validation: Check that any auth variables present are fully expanded
        // Only validate variables that are actually set (different agents need different auth)
        const potentialAuthVars = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME', 'AZURE_OPENAI_API_KEY', 'TOGETHER_API_KEY'];
        const unexpandedAuthVars = potentialAuthVars.filter(varName => {
          const value = extraEnv[varName];
          // Only fail if variable IS SET and contains unexpanded ${VAR} references
          return value && typeof value === 'string' && value.includes('${');
        });

        if (unexpandedAuthVars.length > 0) {
          // Extract the specific missing variable names from unexpanded references
          const missingVarDetails = unexpandedAuthVars.map(authVar => {
            const value = extraEnv[authVar];
            const unresolvedMatch = value?.match(/\$\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?\}/);
            const missingVar = unresolvedMatch ? unresolvedMatch[1] : 'unknown';
            return `${authVar} references \${${missingVar}} which is not defined`;
          });

          const errorMessage = `Authentication will fail - environment variables not found in daemon: ${missingVarDetails.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment (not just your shell) before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        // Check if tmux is available and should be used
        const tmuxAvailable = await isTmuxAvailable();
        let useTmux = tmuxAvailable;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, gemini, cursor, cursor-acp, acp-cursor
          let agent: string;
          if (options.agent === 'gemini') agent = 'gemini';
          else if (options.agent === 'codex') agent = 'codex';
          else if (options.agent === 'cursor') agent = 'cursor';
          else if (options.agent === 'cursor-acp' || options.agent === 'acp-cursor') agent = 'acp cursor';
          else agent = 'claude';
          const resumeArg = shouldPassResumeSessionTag && resumeSessionTag ? ` --resume-session-tag ${JSON.stringify(resumeSessionTag)}` : '';
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --happy-starting-mode remote --started-by daemon${resumeArg}`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const windowName = `happy-${Date.now()}-${agent.replace(/\s+/g, '-')}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          // Add extra environment variables (these should already be filtered)
          Object.assign(tmuxEnv, extraEnv);

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              directory,
              agent: options.agent ?? 'cursor',
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            return new Promise((resolve) => {
              // Set timeout for webhook (same as regular flow)
              const timeout = setTimeout(() => {
                pidToAwaiter.delete(tmuxResult.pid!);
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
                resolve({
                  type: 'error',
                  errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
                });
              }, SESSION_WEBHOOK_TIMEOUT_MS);

              // Register awaiter for tmux session (exact same as regular flow)
              pidToAwaiter.set(tmuxResult.pid!, (completedSession) => {
                clearTimeout(timeout);
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
                resolve({
                  type: 'success',
                  sessionId: completedSession.happySessionId!
                });
              });
            });
          } else {
            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI - support claude, codex, gemini, cursor, cursor-acp, acp-cursor
          let agentArgs: string[];
          switch (options.agent) {
            case 'claude':
            case undefined:
              agentArgs = ['claude'];
              break;
            case 'codex':
              agentArgs = ['codex'];
              break;
            case 'cursor':
              agentArgs = ['cursor'];
              break;
            case 'gemini':
              agentArgs = ['gemini'];
              break;
            case 'cursor-acp':
            case 'acp-cursor':
              agentArgs = ['acp', 'cursor'];
              break;
            default:
              return {
                type: 'error',
                errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
              };
          }
          const args = [
            ...agentArgs,
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon'
          ];
          if (shouldPassResumeSessionTag && resumeSessionTag) {
            args.push('--resume-session-tag', resumeSessionTag);
          }

          const baseEnv = { ...process.env };
          const happyProcess = spawnHappyCLI(args, {
            cwd: directory,
            detached: true,  // Sessions stay alive when daemon stops
            stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
            env: {
              ...baseEnv,
              ...extraEnv
            }
          });

          // Log output for debugging
          if (process.env.DEBUG) {
            happyProcess.stdout?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
            });
            happyProcess.stderr?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
            });
          }

          if (!happyProcess.pid) {
            logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
            return {
              type: 'error',
              errorMessage: 'Failed to spawn Happy process - no PID returned'
            };
          }

          logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

          const trackedSession: TrackedSession = {
            startedBy: 'daemon',
            pid: happyProcess.pid,
            childProcess: happyProcess,
            directoryCreated,
            directory,
            agent: options.agent ?? 'cursor',
            spawnTime: Date.now(),
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
          };

          pidToTrackedSession.set(happyProcess.pid, trackedSession);

          happyProcess.on('exit', (code, signal) => {
            const s = pidToTrackedSession.get(happyProcess.pid!);
            const sessionId = s?.happySessionId ?? 'unknown';
            const duration = s?.spawnTime ? Math.round((Date.now() - s.spawnTime) / 1000) : null;
            logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} (session ${sessionId}) exited: code=${code} signal=${signal}${duration !== null ? ` after ${duration}s` : ''}`);
            if (happyProcess.pid) {
              onChildExited(happyProcess.pid, code, signal);
            }
          });

          happyProcess.on('error', (error) => {
            logger.debug(`[DAEMON RUN] Child process error:`, error);
            if (happyProcess.pid) {
              const session = pidToTrackedSession.get(happyProcess.pid);
              if (session && !session.exitReason) {
                session.exitReason = `spawn error: ${error.message}`;
                session.exitTime = Date.now();
              }
              onChildExited(happyProcess.pid, 1, null);
            }
          });

          // Wait for webhook to populate session with happySessionId
          logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

          return new Promise((resolve) => {
            // Set timeout for webhook
            const timeout = setTimeout(() => {
              pidToAwaiter.delete(happyProcess.pid!);
              logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
              resolve({
                type: 'error',
                errorMessage: `Session webhook timeout for PID ${happyProcess.pid}`
              });
            }, SESSION_WEBHOOK_TIMEOUT_MS);

            // Register awaiter
            pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
              clearTimeout(timeout);
              logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
              resolve({
                type: 'success',
                sessionId: completedSession.happySessionId!
              });
            });
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    // Stop a session by sessionId or PID fallback.
    // Keep the session tracked until the real exit path runs so it can still
    // move into stoppedSessions / recentlyExited and remain restartable.
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (session.startedBy === 'daemon' && session.childProcess) {
            try {
              session.childProcess.kill('SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              process.kill(pid, 'SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }

          persistSessionTagBeforeRemove(session);
          logger.debug(`[DAEMON RUN] Stop requested for session ${sessionId}; keeping it tracked until exit is observed`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Stop by PID only (no mapping required) – e.g. happy daemon stop-session --pid 88206.
    // Keep tracked sessions in memory until exit is observed so restart-session can still
    // find them if the process is only being stopped, not archived.
    const stopSessionByPid = (pid: number): boolean => {
      logger.debug(`[DAEMON RUN] Stop by PID: ${pid}`);
      const session = pidToTrackedSession.get(pid);
      if (session) persistSessionTagBeforeRemove(session);
      try {
        process.kill(pid, 'SIGTERM');
        logger.debug(`[DAEMON RUN] Sent SIGTERM to PID ${pid}; waiting for exit before removing from tracking`);
        return true;
      } catch (err: unknown) {
        const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
        if (code === 'ESRCH') {
          // Process does not exist – synthesize the exit path so the daemon
          // still records a stopped/recently-exited tombstone if this PID was tracked.
          onChildExited(pid, null, 'SIGTERM');
          logger.debug(`[DAEMON RUN] PID ${pid} already gone (ESRCH)`);
          return true;
        }
        logger.debug(`[DAEMON RUN] Failed to kill PID ${pid}:`, err);
        return false;
      }
    };

    // Handle child process exit
    const onChildExited = (pid: number, code?: number | null, signal?: string | null) => {
      const session = pidToTrackedSession.get(pid);
      if (session) {
        if (session.exitCode === undefined && session.exitSignal === undefined) {
          session.exitCode = code ?? null;
          session.exitSignal = signal ?? null;
        }
        if (!session.exitReason) {
          session.exitReason = resolveExitReason(code ?? null, signal);
        }
        session.exitTime = session.exitTime ?? Date.now();
        persistSessionTagBeforeRemove(session);
        pushRecentlyExited(session);
        if (session.pendingArchive) {
          // App-initiated archive (killSession RPC): do not keep in list
          logger.debug(`[DAEMON RUN] Session ${session.happySessionId} (PID ${pid}) archived by app, removing from list`);
        } else {
          // Process exited on its own (pause / signal / crash): keep visible until user archives
          logger.debug(`[DAEMON RUN] Session ${session.happySessionId} (PID ${pid}) exited (reason: ${session.exitReason}), moving to stoppedSessions`);
          if (session.happySessionId) {
            stoppedSessions.set(session.happySessionId, { ...session, childProcess: undefined });
            persistNow();
          }
        }
      } else {
        logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      }
      pidToTrackedSession.delete(pid);
    };

    /** Remove a stopped session from the visible list (explicit user action). */
    const archiveSession = (sessionId: string): boolean => {
      let removed = stoppedSessions.delete(sessionId);
      if (removed) {
        logger.debug(`[DAEMON RUN] Archived session ${sessionId}`);
      }
      // Also handle the edge case where it's still in active tracking (e.g. archive while running)
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId) {
          pidToTrackedSession.delete(pid);
          logger.debug(`[DAEMON RUN] Archived active session ${sessionId} (PID ${pid})`);
          removed = true;
          break;
        }
      }
      if (removed) persistNow();
      return removed;
    };

    // Restart a session: kill existing process and spawn a new one reconnecting to the same server session
    const restartSession = async (sessionId: string): Promise<{ success: boolean; newSessionId?: string; error?: string }> => {
      logger.debug(`[DAEMON RUN] Restart session: ${sessionId}`);

      // Find in active sessions first, then stoppedSessions, then recently-exited ring buffer
      let found: TrackedSession | undefined;
      for (const session of pidToTrackedSession.values()) {
        if (session.happySessionId === sessionId) { found = session; break; }
      }
      if (!found) {
        found = stoppedSessions.get(sessionId);
        if (found) logger.debug(`[DAEMON RUN] Restart: session ${sessionId} found in stoppedSessions`);
      }
      if (!found) {
        found = recentlyExited.slice().reverse().find((s: TrackedSession) => s.happySessionId === sessionId);
        if (found) {
          logger.debug(`[DAEMON RUN] Restart: session ${sessionId} found in recentlyExited (exitReason: ${found.exitReason ?? 'unknown'})`);
        }
      }

      if (!found) {
        logger.debug(`[DAEMON RUN] Restart: session ${sessionId} not found`);
        return { success: false, error: 'Session not found' };
      }

      if (!found.directory) {
        logger.debug(`[DAEMON RUN] Restart: session ${sessionId} has no directory`);
        return { success: false, error: 'Session directory unknown (session may predate restart support)' };
      }

      const { directory, agent } = found;
      const sessionTag = found.sessionTag ?? lastSessionTagBySessionId[sessionId] ?? lastSessionTagByDirectory[directory];

      // Kill existing process if still running
      stopSession(sessionId);

      // Wait briefly for process to die
      await new Promise((r) => setTimeout(r, 500));

      // Spawn new process, reconnecting to the same server session via explicit CLI arg.
      const result = await spawnSession({
        directory,
        agent,
        resumeSessionTag: sessionTag,
      });

      if (result.type === 'success') {
        // Remove old stopped entry — new session is live under a new ID
        stoppedSessions.delete(sessionId);
        logger.debug(`[DAEMON RUN] Restarted session ${sessionId} -> new session ${result.sessionId}`);
        return { success: true, newSessionId: result.sessionId };
      } else {
        logger.debug(`[DAEMON RUN] Restart spawn failed:`, result);
        return { success: false, error: result.type === 'error' ? result.errorMessage : 'Spawn failed' };
      }
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      getRecentlyExited,
      stopSession,
      stopSessionByPid,
      spawnSession,
      restartSession,
      archiveSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook,
      onSessionEnding,
    });

    // Periodic liveness check: verify sessions are still running by checking their PID.
    // - PID alive   → keep session, just note if heartbeat is stale
    // - PID gone    → evict (process is dead regardless of heartbeat state)
    // Sessions with a childProcess also get cleaned up via the 'exit' event,
    // but the PID check here catches any that slip through (e.g. SIGKILL).
    const SESSION_HEARTBEAT_STALE_MS = 90_000; // 3× heartbeat interval
    const ttlCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [pid, session] of pidToTrackedSession.entries()) {
        const pidAlive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
        if (!pidAlive) {
          if (!session.exitReason) {
            session.exitReason = 'evicted (pid missing — no exit event received)';
            session.exitTime = session.exitTime ?? Date.now();
          }
          logger.debug(`[DAEMON RUN] Evicting dead session ${session.happySessionId} (PID ${pid} not found, reason: ${session.exitReason})`);
          persistSessionTagBeforeRemove(session);
          pushRecentlyExited(session);
          if (session.happySessionId) {
            stoppedSessions.set(session.happySessionId, { ...session, childProcess: undefined });
            persistNow();
          }
          pidToTrackedSession.delete(pid);
          continue;
        }
        // PID alive: just log if heartbeat is stale (for visibility), do not evict
        if (session.lastHeartbeat && now - session.lastHeartbeat > SESSION_HEARTBEAT_STALE_MS) {
          logger.debug(`[DAEMON RUN] Session ${session.happySessionId} (PID ${pid}) is alive but heartbeat is stale (${Math.round((now - session.lastHeartbeat) / 1000)}s ago)`);
        }
      }
    }, 30_000);
    ttlCleanupInterval.unref(); // don't prevent daemon from exiting

    // Write initial daemon state (no lock needed for state file). Load persisted maps so we don't drop them on restart.
    const prevState = await readDaemonState();
    if (prevState?.lastSessionTagByDirectory) Object.assign(lastSessionTagByDirectory, prevState.lastSessionTagByDirectory);
    if (prevState?.lastSessionTagBySessionId) Object.assign(lastSessionTagBySessionId, prevState.lastSessionTagBySessionId);
    if (prevState?.lastDirectoryBySessionId) Object.assign(lastDirectoryBySessionId, prevState.lastDirectoryBySessionId);
    if (prevState?.lastAgentBySessionId) Object.assign(lastAgentBySessionId, prevState.lastAgentBySessionId);
    // Restore stopped sessions from previous daemon state (tombstone survives clean shutdown)
    const persistedStopped = prevState?.stoppedSessions;
    if (persistedStopped) {
      const MAX_STOPPED_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
      const now = Date.now();
      for (const s of persistedStopped) {
        if (s.exitTime && now - s.exitTime > MAX_STOPPED_AGE_MS) continue;
        stoppedSessions.set(s.happySessionId, {
          startedBy: 'daemon',
          happySessionId: s.happySessionId,
          pid: s.pid,
          directory: s.directory,
          sessionTag: s.sessionTag,
          agent: s.agent as any,
          exitReason: s.exitReason,
          exitTime: s.exitTime,
          lastHeartbeat: s.lastHeartbeat,
        });
      }
      logger.debug(`[DAEMON RUN] Restored ${stoppedSessions.size} stopped session(s) from persisted state`);
    }
    const serializeStoppedSessions = () =>
      Array.from(stoppedSessions.values()).map(s => ({
        happySessionId: s.happySessionId!,
        pid: s.pid,
        directory: s.directory,
        sessionTag: s.sessionTag,
        agent: s.agent,
        exitReason: s.exitReason,
        exitTime: s.exitTime,
        lastHeartbeat: s.lastHeartbeat,
      }));

    /** Write the full daemon state snapshot to disk immediately. */
    const persistNow = () => {
      writeDaemonState({
        pid: process.pid,
        httpPort: controlPort,
        startTime: fileState.startTime,
        startedWithCliVersion: packageJson.version,
        lastHeartbeat: fileState.lastHeartbeat,
        daemonLogPath: fileState.daemonLogPath,
        lastSessionTagByDirectory: { ...lastSessionTagByDirectory },
        lastSessionTagBySessionId: { ...lastSessionTagBySessionId },
        lastDirectoryBySessionId: { ...lastDirectoryBySessionId },
        lastAgentBySessionId: { ...lastAgentBySessionId },
        stoppedSessions: serializeStoppedSessions(),
      });
    };
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath,
      lastSessionTagByDirectory: { ...lastSessionTagByDirectory },
      lastSessionTagBySessionId: { ...lastSessionTagBySessionId },
      lastDirectoryBySessionId: { ...lastDirectoryBySessionId },
      lastAgentBySessionId: { ...lastAgentBySessionId },
      stoppedSessions: serializeStoppedSessions(),
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    apiMachine.connect();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, session] of pidToTrackedSession.entries()) {
        try {
          process.kill(pid, 0);
        } catch {
          logger.debug(`[DAEMON RUN] Moving stale session PID ${pid} to stoppedSessions`);
          if (!session.exitReason) session.exitReason = 'evicted (pid missing — detected in heartbeat)';
          session.exitTime = session.exitTime ?? Date.now();
          persistSessionTagBeforeRemove(session);
          pushRecentlyExited(session);
          if (session.happySessionId) {
            stoppedSessions.set(session.happySessionId, { ...session, childProcess: undefined });
          }
          pidToTrackedSession.delete(pid);
        }
      }

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      const projectVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
      if (projectVersion !== configuration.currentCliVersion) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Spawn new daemon through the CLI
        // We do not need to clean ourselves up - we will be killed by
        // the CLI start command.
        // 1. It will first check if daemon is running (yes in this case)
        // 2. If the version is stale (it will read daemon.state.json file and check startedWithCliVersion) & compare it to its own version
        // 3. Next it will start a new daemon with the latest version with daemon-sync :D
        // Done!
        try {
          spawnHappyCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        // So we can just hang forever
        logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
        await new Promise(resolve => setTimeout(resolve, 10_000));
        process.exit(0);
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath,
          lastSessionTagByDirectory: { ...lastSessionTagByDirectory },
          lastSessionTagBySessionId: { ...lastSessionTagBySessionId },
          lastDirectoryBySessionId: { ...lastDirectoryBySessionId },
          lastAgentBySessionId: { ...lastAgentBySessionId },
          stoppedSessions: serializeStoppedSessions(),
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      // Poll server for sessions with new messages; auto-respawn stopped sessions.
      try {
        const RESPAWN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between respawn attempts per session
        const pollSince = sessionPollSince;
        sessionPollSince = Date.now();

        const changedSessions = await api.listChangedSessions(pollSince);
        logger.debug(`[DAEMON RUN] Session poll: ${changedSessions.length} session(s) changed since last heartbeat`);

        const now = Date.now();
        for (const { id, seq, active } of changedSessions) {
          const prevSeq = lastSeqBySessionId[id] ?? -1;

          // Always update seq so next cycle has fresh baseline
          if (seq > prevSeq) lastSeqBySessionId[id] = seq;

          // First poll: only record baselines, don't spawn (avoids respawning for already-seen messages)
          if (!initialPollDone) continue;

          // No seq increase since last poll
          if (seq <= prevSeq) continue;

          // Server still considers session active
          if (active) continue;

          // Session is already running locally
          const isRunning = Array.from(pidToTrackedSession.values()).some(s => s.happySessionId === id);
          if (isRunning) continue;

          // No known directory → can't spawn
          const directory = lastDirectoryBySessionId[id];
          if (!directory) continue;

          // Cooldown: avoid rapid re-spawn if session keeps crashing or timing out
          const lastAttempt = lastSpawnAttemptBySessionId[id] ?? 0;
          if (now - lastAttempt < RESPAWN_COOLDOWN_MS) {
            logger.debug(`[DAEMON RUN] Auto-respawn cooldown active for session ${id} (last attempt ${Math.round((now - lastAttempt) / 1000)}s ago)`);
            continue;
          }

          const tag = lastSessionTagBySessionId[id] ?? lastSessionTagByDirectory[directory];
          const agent = (lastAgentBySessionId[id] as 'cursor' | 'claude' | 'codex' | 'gemini' | 'acp-cursor') ?? 'cursor';
          logger.debug(`[DAEMON RUN] Auto-respawning session ${id} (${agent}) in ${directory} (seq ${prevSeq} → ${seq}, tag=${tag?.slice(0, 8) ?? '?'})`);

          lastSpawnAttemptBySessionId[id] = now;

          // Fire-and-forget: don't block heartbeat on 60s webhook timeout
          spawnSession({
            directory,
            agent,
            resumeSessionTag: tag
          }).catch((err: unknown) => {
            logger.debug(`[DAEMON RUN] Auto-respawn failed for session ${id}:`, err);
          });
        }

        initialPollDone = true;
      } catch (err) {
        logger.debug('[DAEMON RUN] Session poll error:', err);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
