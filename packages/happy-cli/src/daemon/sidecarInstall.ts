/**
 * Installs the sidecar as a LaunchAgent in the user's GUI session.
 *
 * The daemon runs under launchd's system domain; the sidecar has to run in `gui/$UID`, which only
 * exists after a user logs in. Writing the job is not enough — it must be bootstrapped into the
 * running GUI domain so it starts now, and RunAtLoad/KeepAlive keep it there across login and
 * crashes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

const LABEL = 'com.happy-cli.sidecar';

function plistPath(): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Installs and starts the sidecar for the current user. Returns the plist path. */
export function installSidecar(): string {
    const target = plistPath();
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    const program = process.execPath;
    const entry = process.argv[1];
    if (!entry) {
        throw new Error('cannot determine the daemon entry point to install');
    }
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(program)}</string>
    <string>${escapeXml(entry)}</string>
    <string>daemon</string>
    <string>sidecar</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HAPPY_HOME_DIR</key><string>${escapeXml(configuration.happyHomeDir)}</string>
    <key>HAPPY_SIDECAR</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>${escapeXml(join(configuration.happyHomeDir, 'logs', 'sidecar.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(configuration.happyHomeDir, 'logs', 'sidecar.err'))}</string>
</dict>
</plist>
`;
    writeFileSync(target, plist, { mode: 0o644 });
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (uid < 0) {
        throw new Error('the sidecar needs a logged-in user');
    }
    try {
        execFileSync('launchctl', ['bootout', `gui/${uid}`, target], { stdio: 'ignore' });
    } catch {
        // not loaded yet
    }
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, target], { stdio: 'inherit' });
    logger.debug(`[SIDECAR] installed ${LABEL} at ${target}`);
    return target;
}

export function uninstallSidecar(): void {
    const target = plistPath();
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (uid >= 0) {
        try {
            execFileSync('launchctl', ['bootout', `gui/${uid}`, target], { stdio: 'ignore' });
        } catch {
            // not loaded
        }
    }
    if (existsSync(target)) {
        unlinkSync(target);
    }
}
