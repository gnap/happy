/**
 * Linux systemd user service management for Happy daemon
 *
 * Uses `systemctl --user` (no sudo required) to manage the daemon as a
 * persistent user service that survives terminal/session closes.
 *
 * User logout still stops user systemd unless linger is enabled; install enables
 * `loginctl enable-linger` so the daemon keeps running after logout.
 *
 * Background: `detached: true` in Node.js calls setsid() which escapes the
 * process group, but on Linux with systemd the daemon remains in the parent's
 * cgroup (session-N.scope). When that session closes, systemd sends SIGTERM to
 * all processes in the scope — including the daemon. A proper user service
 * runs outside any session scope and is immune to this.
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'os';
import { projectPath } from '@/projectPath';
import { getHappyCliLaunchSpec } from '@/utils/spawnHappyCLI';

export const SERVICE_NAME = 'happy-daemon';

export function serviceFilePath(): string {
  return join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

/**
 * Single source of truth for every environment variable the daemon and the
 * agent processes it spawns can see. Edit this file to add/override anything
 * (PATH, ANTHROPIC_*, custom creds, runtime overrides, …) — no code change
 * or unit rewrite required. Re-read with `systemctl --user restart happy-daemon`.
 */
export function envFilePath(): string {
  return join(os.homedir(), '.config', 'happy', 'daemon.env');
}

export function isSystemdAvailable(): boolean {
  try {
    execFileSync('systemctl', ['--user', '--no-pager', 'is-system-running'], {
      stdio: 'ignore',
      timeout: 2000,
    });
    return true;
  } catch {
    // is-system-running exits non-zero on degraded/starting, but binary exists
    try {
      execFileSync('systemctl', ['--version'], { stdio: 'ignore', timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}

export function isServiceInstalled(): boolean {
  return existsSync(serviceFilePath());
}

export function getServiceActiveState(): 'active' | 'inactive' | 'failed' | 'unknown' {
  try {
    const out = execFileSync('systemctl', ['--user', 'is-active', SERVICE_NAME], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    return out as 'active' | 'inactive' | 'failed';
  } catch (e: any) {
    const out = (e?.stdout ?? '').trim();
    if (out === 'inactive' || out === 'failed') return out;
    return 'unknown';
  }
}

export function generateServiceContent(): string {
  const launchSpec = getHappyCliLaunchSpec('bun');
  const execStart = [launchSpec.executable, ...launchSpec.argsPrefix, 'daemon', 'start-sync']
    .map((part) => JSON.stringify(part))
    .join(' ');

  return [
    '[Unit]',
    'Description=Happy CLI Daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    `WorkingDirectory=${projectPath()}`,
    // All daemon environment (PATH, HAPPY_*, ANTHROPIC_* and any user creds)
    // is sourced from a single editable env file — see envFilePath(). The
    // leading `-` tolerates a missing file so the service still starts before
    // it's been populated. Update vars by editing that file and running:
    //   systemctl --user restart happy-daemon
    `EnvironmentFile=-${envFilePath()}`,
    'Restart=on-failure',
    'RestartSec=5s',
    // Only signal the daemon main PID. `mixed` / `control-group` would SIGKILL every
    // process in the service cgroup and defeat detached session spawns (daemon/run.ts).
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * Seed content for the daemon env file, captured from the shell that runs
 * `happy daemon install`. Only used on first install; existing env files are
 * never overwritten so user edits (custom tokens, model overrides, etc.) are
 * preserved across reinstalls.
 *
 * systemd's `--user` default PATH is just `/usr/local/bin:/usr/bin`, which
 * misses homebrew, ~/.local/bin, ~/.cargo/bin, etc., so snapshotting the
 * install-time PATH here matters. Other vars are convenience defaults the
 * daemon code reads at startup.
 */
function generateDefaultEnvFile(): string {
  const home = os.homedir();
  const runtime = getHappyCliLaunchSpec('bun').runtime;
  const lines = [
    '# Single source of truth for happy-daemon environment.',
    '# Seeded by `happy daemon install` from the invoking shell.',
    '# Reload with: systemctl --user restart happy-daemon',
    '',
    `HOME=${home}`,
    `HAPPY_HOME_DIR=${process.env.HAPPY_HOME_DIR ?? join(home, '.happy')}`,
    `HAPPY_PROJECT_ROOT=${process.env.HAPPY_PROJECT_ROOT ?? projectPath()}`,
    `HAPPY_CLI_RUNTIME=${runtime}`,
  ];
  if (process.env.HAPPY_SERVER_URL) {
    lines.push(`HAPPY_SERVER_URL=${process.env.HAPPY_SERVER_URL}`);
  }
  if (process.env.PATH) {
    lines.push(`PATH=${process.env.PATH}`);
  }
  lines.push(
    '',
    '# Add anything else your sessions need below, e.g.:',
    '#   ANTHROPIC_AUTH_TOKEN=sk-...',
    '#   ANTHROPIC_BASE_URL=https://...',
  );
  return lines.join('\n') + '\n';
}

export function installService(): void {
  const serviceDir = join(os.homedir(), '.config', 'systemd', 'user');
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(serviceFilePath(), generateServiceContent());

  // Seed the env file only on first install. Never clobber user edits —
  // they may contain secrets or model/provider overrides the user tuned.
  const envFile = envFilePath();
  if (!existsSync(envFile)) {
    mkdirSync(dirname(envFile), { recursive: true });
    writeFileSync(envFile, generateDefaultEnvFile(), { mode: 0o600 });
  }

  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'pipe' });
}

export function uninstallService(): void {
  try { execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' }); } catch {}
  try { execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'pipe' }); } catch {}
  const file = serviceFilePath();
  if (existsSync(file)) unlinkSync(file);
  try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch {}
}

export function startService(): void {
  execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'pipe' });
}

/** Whether user@.service stays up after logout (loginctl linger). */
export function isUserLingerEnabled(): boolean {
  try {
    const out = execFileSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    return out === 'yes';
  } catch {
    return false;
  }
}

/**
 * Keep user systemd (and happy-daemon) running after full logout.
 * Usually does not require sudo when enabling linger for the current user.
 */
export function enableUserLinger(): void {
  const user = os.userInfo().username;
  execFileSync('loginctl', ['enable-linger', user], { stdio: 'pipe', timeout: 5000 });
}

export type UserLingerResult =
  | { ok: true; alreadyEnabled: boolean }
  | { ok: false; error: string };

/** Best-effort linger enable; never throws (install falls back to login-only systemd). */
export function tryEnableUserLinger(): UserLingerResult {
  if (isUserLingerEnabled()) {
    return { ok: true, alreadyEnabled: true };
  }
  try {
    enableUserLinger();
    return { ok: true, alreadyEnabled: false };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error };
  }
}

export function stopService(): void {
  execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' });
}
