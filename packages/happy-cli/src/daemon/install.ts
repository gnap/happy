import { logger } from '@/ui/logger';

export type DaemonInstallOptions = {
    /**
     * macOS: prefer LaunchDaemon (root). Without root, install LaunchAgent and warn only.
     * Linux: best-effort loginctl enable-linger on every install; failure warns, install continues.
     */
    persistAcrossLogout?: boolean;
};

export async function install(options?: DaemonInstallOptions): Promise<void> {
    if (process.platform === 'darwin') {
        logger.info('Installing Happy CLI daemon for macOS...');
        const { install: installMac } = await import('./mac/install');
        await installMac({ persistAcrossLogout: options?.persistAcrossLogout });
    } else if (process.platform === 'linux') {
        logger.info('Installing Happy CLI daemon for Linux (systemd user service)...');
        const { install: installLinux } = await import('./linux/install');
        await installLinux();
    } else {
        throw new Error(`Daemon installation is not supported on ${process.platform}`);
    }
}