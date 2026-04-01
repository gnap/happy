/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync } from 'fs';
import { join } from 'path';
import { configuration } from '@/configuration';

async function daemonPost(path: string, body?: any): Promise<{ error?: string } | any> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    process.kill(state.pid!, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = process.env.HAPPY_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.HAPPY_DAEMON_HTTP_TIMEOUT) : 30_000;
    const response = await fetch(`http://127.0.0.1:${state.httpPort!}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage
      };
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<{ error?: string } | any> {
  return await daemonPost('/session-started', {
    sessionId,
    metadata
  });
}

/**
 * Notify the daemon that this session process is about to exit.
 * Call this before process.exit() so the daemon can record the reason
 * without waiting for the periodic PID check (which would only log "evicted").
 *
 * @param sessionId - The happy server session ID
 * @param pid       - process.pid of the session process
 * @param reason    - Human-readable exit reason (e.g. 'completed normally', 'killed by app', 'signal: SIGTERM')
 * @param exitCode  - Optional process exit code (0 = success, non-zero = error)
 */
export async function notifyDaemonSessionEnding(
  sessionId: string,
  pid: number,
  reason: string,
  exitCode?: number,
  archive?: boolean,
): Promise<void> {
  try {
    await daemonPost('/session-ending', { sessionId, pid, reason, exitCode, archive });
  } catch {
    // Best-effort; do not block the exit path
  }
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

/**
 * Stop a session by session id (requires daemon to have it in its mapping)
 * or by PID (no mapping needed).
 */
export async function stopDaemonSession(sessionIdOrPid: string | number): Promise<boolean> {
  const body = typeof sessionIdOrPid === 'number'
    ? { pid: sessionIdOrPid }
    : { sessionId: sessionIdOrPid };
  const result = await daemonPost('/stop-session', body);
  return result.success || false;
}

export async function listDaemonSessionHistory(): Promise<any[]> {
  const result = await daemonPost('/list-history');
  return result.recentlyExited || [];
}

export async function restartDaemonSession(sessionId: string): Promise<{ success: boolean; newSessionId?: string; error?: string }> {
  const result = await daemonPost('/restart-session', { sessionId });
  return result;
}

export async function archiveDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/archive-session', { sessionId });
  return result.success || false;
}

/**
 * Spawn a new session in the given directory (e.g. to reconnect from server session list).
 * Optional agent and environmentVariables (e.g. HAPPY_CURSOR_SESSION_TAG for same server session).
 */
export async function spawnDaemonSession(opts: {
  directory: string;
  agent?: 'claude' | 'codex' | 'cursor' | 'gemini';
  environmentVariables?: Record<string, string>;
  resumeSessionTag?: string;
}): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  const result = await daemonPost('/spawn-session', {
    directory: opts.directory,
    agent: opts.agent,
    environmentVariables: opts.environmentVariables,
    resumeSessionTag: opts.resumeSessionTag
  });
  if (result.error) return { success: false, error: result.error };
  if (result.success && result.sessionId) return { success: true, sessionId: result.sessionId };
  if (result.success) return { success: true };
  return { success: false, error: (result as any).error ?? 'Spawn failed' };
}

export async function stopDaemonHttp(): Promise<void> {
  await daemonPost('/stop');
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded happy,
 * the daemon is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 * 
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 * 
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another daemon to make sure 
 * our daemon is always alive and running the latest version.
 * 
 * That seems like an overkill and yet another process to manage - lets not do this :D
 * 
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 * 
 * We can destructure the response on the caller for richer output.
 * For instance when running `happy daemon status` we can show more information.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) return false;

  // Tombstone state: daemon cleanly stopped but session data was preserved — not running
  if (!state.pid || !state.httpPort) return false;

  // Check if the daemon process is still alive
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    // Stale state (process died unexpectedly): clear the live fields but keep session data
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up stale state');
    await cleanupDaemonState();
    return false;
  }
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }
  
  try {
    // Read package.json on demand from disk - so we are guaranteed to get the latest version
    const packageJsonPath = join(projectPath(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const currentCliVersion = packageJson.version;
    
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
    return currentCliVersion === state.startedWithCliVersion;
    
    // PREVIOUS IMPLEMENTATION - Keeping this commented in case we need it
    // Kirill does not understand how the upgrade of npm packages happen and whether 
    // we will get a new path or not when happy-coder is upgraded globally.
    // If reading package.json doesn't work correctly after npm upgrades, 
    // we can revert to spawning a process (but should add timeout and cleanup!)
    /*
    const { spawnHappyCLI } = await import('@/utils/spawnHappyCLI');
    const happyProcess = spawnHappyCLI(['--version'], { stdio: 'pipe' });
    let version: string | null = null;
    happyProcess.stdout?.on('data', (data) => {
      version = data.toString().trim();
    });
    await new Promise(resolve => happyProcess.stdout?.on('close', resolve));
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${version}, Daemon started with version: ${state.startedWithCliVersion}`);
    return version === state.startedWithCliVersion;
    */
  } catch (error) {
    logger.debug('[DAEMON CONTROL] Error checking daemon version', error);
    return false;
  }
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon() {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    if (!state.pid || !state.httpPort) {
      logger.debug('No daemon running (tombstone state)');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp();

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    // Force kill
    try {
      process.kill(state.pid, 'SIGKILL');
      logger.debug('Force killed daemon');
    } catch (error) {
      logger.debug('Daemon already dead');
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}