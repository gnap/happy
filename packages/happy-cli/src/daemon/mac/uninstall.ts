/**
 * Uninstallation script for Happy daemon LaunchAgent / LaunchDaemon.
 *
 * Variant-aware: defaults to "stable" but uninstalls the dev plist when
 * HAPPY_VARIANT=dev is set in the environment.
 */

import { existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import { logger } from '@/ui/logger';

type Variant = 'stable' | 'dev';

const PLIST_LABEL_BASE = 'com.happy-cli.daemon';

function resolveVariant(): Variant {
    const raw = (process.env.HAPPY_VARIANT || '').toLowerCase();
    return raw === 'dev' ? 'dev' : 'stable';
}

function resolvePlistLabel(variant: Variant): string {
    return variant === 'dev' ? `${PLIST_LABEL_BASE}.dev` : PLIST_LABEL_BASE;
}

function getPlistPath(label: string): string {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
        return `/Library/LaunchDaemons/${label}.plist`;
    }
    return `${os.homedir()}/Library/LaunchAgents/${label}.plist`;
}

function getLaunchctlDomain(): string {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) return 'system';
    const uid = process.getuid?.() ?? 0;
    return `gui/${uid}`;
}

export async function uninstall(): Promise<void> {
    try {
        const variant = resolveVariant();
        const label = resolvePlistLabel(variant);
        const plistFile = getPlistPath(label);
        const domain = getLaunchctlDomain();

        logger.info(`Uninstalling Happy CLI daemon (variant: ${variant}, label: ${label})`);

        if (!existsSync(plistFile)) {
            logger.info('Daemon plist not found. Nothing to uninstall.');
            return;
        }

        try {
            execSync(`launchctl bootout ${domain} ${plistFile}`, { stdio: 'inherit' });
            logger.info('Daemon stopped successfully');
        } catch {
            logger.info('Failed to unload daemon (it might not be running)');
        }

        unlinkSync(plistFile);
        logger.info(`Removed daemon plist from ${plistFile}`);
        logger.info('Daemon uninstalled successfully');
    } catch (error) {
        logger.debug('Failed to uninstall daemon:', error);
        throw error;
    }
}
