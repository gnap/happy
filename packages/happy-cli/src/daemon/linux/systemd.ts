/**
 * Linux systemd user service management for Happy daemon
 *
 * Uses `systemctl --user` (no sudo required) to manage the daemon as a
 * persistent user service that survives terminal/session closes.
 *
 * Background: `detached: true` in Node.js calls setsid() which escapes the
 * process group, but on Linux with systemd the daemon remains in the parent's
 * cgroup (session-N.scope). When that session closes, systemd sends SIGTERM to
 * all processes in the scope — including the daemon. A proper user service
 * runs outside any session scope and is immune to this.
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import os from 'os';
import { projectPath } from '@/projectPath';

export const SERVICE_NAME = 'happy-daemon';

export function serviceFilePath(): string {
  return join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
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
  const home = os.homedir();
  const nodePath = process.execPath;
  const entrypoint = join(projectPath(), 'dist', 'index.mjs');
  const happyHomeDir = process.env.HAPPY_HOME_DIR ?? join(home, '.happy');
  const happyServerUrl = process.env.HAPPY_SERVER_URL ?? '';
  const happyProjectRoot = process.env.HAPPY_PROJECT_ROOT ?? projectPath();

  const envLines = [
    `Environment=HOME=${home}`,
    `Environment=HAPPY_HOME_DIR=${happyHomeDir}`,
    `Environment=HAPPY_PROJECT_ROOT=${happyProjectRoot}`,
    ...(happyServerUrl ? [`Environment=HAPPY_SERVER_URL=${happyServerUrl}`] : []),
  ].join('\n');

  return [
    '[Unit]',
    'Description=Happy CLI Daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${nodePath} --no-warnings --no-deprecation ${entrypoint} daemon start-sync`,
    `WorkingDirectory=${projectPath()}`,
    envLines,
    'Restart=on-failure',
    'RestartSec=5s',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function installService(): void {
  const serviceDir = join(os.homedir(), '.config', 'systemd', 'user');
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(serviceFilePath(), generateServiceContent());
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

export function stopService(): void {
  execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' });
}
