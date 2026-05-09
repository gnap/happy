/**
 * Installation script for Happy daemon using macOS LaunchAgents (or LaunchDaemons when run as root).
 *
 * This installer is variant-aware: stable and dev daemons can be installed side-by-side
 * with separate plist labels, plist files, and home directories.
 *
 * Variant resolution (in priority order):
 *  1. `HAPPY_VARIANT` env var ("stable" | "dev")
 *  2. Default: "stable"
 *
 * Plist labels:
 *  - stable -> com.happy-cli.daemon
 *  - dev    -> com.happy-cli.daemon.dev
 *
 * The plist captures the resolved HAPPY_HOME_DIR (and HAPPY_VARIANT) so launchd
 * spawns the daemon against the correct data directory regardless of who triggers it.
 */

import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';
import { logger } from '@/ui/logger';
import { trimIdent } from '@/utils/trimIdent';
import os from 'os';
import { getHappyCliLaunchSpec } from '@/utils/spawnHappyCLI';

type Variant = 'stable' | 'dev';

const PLIST_LABEL_BASE = 'com.happy-cli.daemon';

function resolveVariant(): Variant {
    const raw = (process.env.HAPPY_VARIANT || '').toLowerCase();
    return raw === 'dev' ? 'dev' : 'stable';
}

function resolvePlistLabel(variant: Variant): string {
    return variant === 'dev' ? `${PLIST_LABEL_BASE}.dev` : PLIST_LABEL_BASE;
}

function resolveHappyHomeDir(variant: Variant): string {
    if (process.env.HAPPY_HOME_DIR) {
        return process.env.HAPPY_HOME_DIR.replace(/^~/, os.homedir());
    }
    return variant === 'dev'
        ? `${os.homedir()}/.happy-dev`
        : `${os.homedir()}/.happy`;
}

/** User-level: ~/Library/LaunchAgents (no sudo). System-level: /Library/LaunchDaemons (sudo). */
function getPlistPath(label: string): string {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
        return `/Library/LaunchDaemons/${label}.plist`;
    }
    return `${os.homedir()}/Library/LaunchAgents/${label}.plist`;
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
        const variant = resolveVariant();
        const label = resolvePlistLabel(variant);
        const plistFile = getPlistPath(label);
        const domain = getLaunchctlDomain();
        const happyHomeDir = resolveHappyHomeDir(variant);

        logger.info(`Installing Happy CLI daemon (variant: ${variant}, label: ${label})`);
        logger.info(`HAPPY_HOME_DIR -> ${happyHomeDir}`);

        if (!existsSync(happyHomeDir)) {
            mkdirSync(happyHomeDir, { recursive: true });
        }

        if (existsSync(plistFile)) {
            logger.info('Daemon plist already exists. Unloading first...');
            try {
                execSync(`launchctl bootout ${domain} ${plistFile}`, { stdio: 'inherit' });
            } catch {
                // May not be loaded (e.g. after reboot), continue
            }
        }

        const launchSpec = getHappyCliLaunchSpec();
        const runtimeEnv = launchSpec.runtime === 'bun' ? 'bun' : 'node';
        const launchdPath = `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

        const plistContent = trimIdent(`
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>Label</key>
                <string>${label}</string>

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
                    <key>HAPPY_VARIANT</key>
                    <string>${variant}</string>
                    <key>HAPPY_HOME_DIR</key>
                    <string>${happyHomeDir}</string>
                    <key>PATH</key>
                    <string>${launchdPath}</string>
                </dict>

                <key>RunAtLoad</key>
                <true/>

                <key>KeepAlive</key>
                <true/>

                <key>StandardErrorPath</key>
                <string>${happyHomeDir}/daemon.err</string>

                <key>StandardOutPath</key>
                <string>${happyHomeDir}/daemon.log</string>

                <key>WorkingDirectory</key>
                <string>/tmp</string>
            </dict>
            </plist>
        `);

        const dir = dirname(plistFile);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(plistFile, plistContent);
        chmodSync(plistFile, 0o644);

        logger.info(`Created daemon plist at ${plistFile}`);

        execSync(`launchctl bootstrap ${domain} ${plistFile}`, { stdio: 'inherit' });

        logger.info('Daemon installed and started successfully');
        logger.info(`Check logs at ${happyHomeDir}/daemon.log`);
    } catch (error) {
        logger.debug('Failed to install daemon:', error);
        throw error;
    }
}
