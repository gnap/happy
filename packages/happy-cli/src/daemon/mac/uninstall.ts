/**
 * Uninstallation script for Happy daemon LaunchDaemon
 * 
 * NOTE: This uninstallation method is currently NOT USED since we moved away from
 * system-level daemon installation. See install.ts for the full explanation.
 * 
 * This code is kept for potential future use if we decide to offer system-level 
 * installation/uninstallation as an option.
 */

import { existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import { logger } from '@/ui/logger';

const PLIST_LABEL = 'com.happy-cli.daemon';

function getPlistPath(): string {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
        return `/Library/LaunchDaemons/${PLIST_LABEL}.plist`;
    }
    return `${os.homedir()}/Library/LaunchAgents/${PLIST_LABEL}.plist`;
}

function getLaunchctlDomain(): string {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) return 'system';
    const uid = process.getuid?.() ?? 0;
    return `gui/${uid}`;
}

export async function uninstall(): Promise<void> {
    try {
        const PLIST_FILE = getPlistPath();
        const domain = getLaunchctlDomain();

        if (!existsSync(PLIST_FILE)) {
            logger.info('Daemon plist not found. Nothing to uninstall.');
            return;
        }

        try {
            execSync(`launchctl bootout ${domain} ${PLIST_FILE}`, { stdio: 'inherit' });
            logger.info('Daemon stopped successfully');
        } catch {
            logger.info('Failed to unload daemon (it might not be running)');
        }

        unlinkSync(PLIST_FILE);
        logger.info(`Removed daemon plist from ${PLIST_FILE}`);
        logger.info('Daemon uninstalled successfully');
    } catch (error) {
        logger.debug('Failed to uninstall daemon:', error);
        throw error;
    }
}