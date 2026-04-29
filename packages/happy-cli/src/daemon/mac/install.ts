/**
 * Installation script for Happy daemon using macOS LaunchDaemons
 * 
 * NOTE: This installation method is currently NOT USED in favor of auto-starting 
 * the daemon when the user runs the happy command. 
 * 
 * Why we're not using this approach:
 * 1. Installing a LaunchDaemon requires sudo permissions, which users might not be comfortable with
 * 2. We assume users will run happy frequently (every time they open their laptop)
 * 3. The auto-start approach provides the same functionality without requiring elevated permissions
 * 
 * This code is kept for potential future use if we decide to offer system-level installation as an option.
 */

import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';
import { logger } from '@/ui/logger';
import { trimIdent } from '@/utils/trimIdent';
import os from 'os';
import { getHappyCliLaunchSpec } from '@/utils/spawnHappyCLI';

const PLIST_LABEL = 'com.happy-cli.daemon';

/** User-level: ~/Library/LaunchAgents (no sudo). System-level: /Library/LaunchDaemons (sudo). */
function getPlistPath(): string {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
        return `/Library/LaunchDaemons/${PLIST_LABEL}.plist`;
    }
    return `${os.homedir()}/Library/LaunchAgents/${PLIST_LABEL}.plist`;
}

/** launchctl domain: system for LaunchDaemons, gui/$uid for LaunchAgents. */
function getLaunchctlDomain(): string {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
        return 'system';
    }
    const uid = process.getuid?.() ?? 0;
    return `gui/${uid}`;
}

export async function install(): Promise<void> {
    try {
        const PLIST_FILE = getPlistPath();
        const domain = getLaunchctlDomain();

        // Check if already installed
        if (existsSync(PLIST_FILE)) {
            logger.info('Daemon plist already exists. Uninstalling first...');
            try {
                execSync(`launchctl bootout ${domain} ${PLIST_FILE}`, { stdio: 'inherit' });
            } catch {
                // May not be loaded (e.g. after reboot), continue
            }
        }

        const launchSpec = getHappyCliLaunchSpec();
        const runtimeEnv = launchSpec.runtime === 'bun' ? 'bun' : 'node';

        // Create plist content
        const plistContent = trimIdent(`
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>Label</key>
                <string>${PLIST_LABEL}</string>
                
                <key>ProgramArguments</key>
                <array>
                    <string>${launchSpec.executable}</string>
                    ${launchSpec.argsPrefix.map((arg) => `<string>${arg}</string>`).join('\n                    ')}
                    <string>daemon</string>
                    <string>start-sync</string>
                </array>
                
                <key>EnvironmentVariables</key>
                <dict>
                    <key>HAPPY_DAEMON_MODE</key>
                    <string>true</string>
                    <key>HAPPY_CLI_RUNTIME</key>
                    <string>${runtimeEnv}</string>
                    <key>PATH</key>
                    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
                </dict>
                
                <key>RunAtLoad</key>
                <true/>
                
                <key>KeepAlive</key>
                <true/>
                
                <key>StandardErrorPath</key>
                <string>${os.homedir()}/.happy/daemon.err</string>
                
                <key>StandardOutPath</key>
                <string>${os.homedir()}/.happy/daemon.log</string>
                
                <key>WorkingDirectory</key>
                <string>/tmp</string>
            </dict>
            </plist>
        `);

        // Write plist file (ensure directory exists for user install)
        const dir = dirname(PLIST_FILE);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(PLIST_FILE, plistContent);
        chmodSync(PLIST_FILE, 0o644);

        logger.info(`Created daemon plist at ${PLIST_FILE}`);

        // Load the daemon
        execSync(`launchctl bootstrap ${domain} ${PLIST_FILE}`, { stdio: 'inherit' });

        logger.info('Daemon installed and started successfully');
        logger.info('Check logs at ~/.happy/daemon.log');

    } catch (error) {
        logger.debug('Failed to install daemon:', error);
        throw error;
    }
}