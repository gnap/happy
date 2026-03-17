import { logger } from '@/ui/logger';

export async function install(): Promise<void> {
    if (process.platform === 'darwin') {
        logger.info('Installing Happy CLI daemon for macOS...');
        const { install: installMac } = await import('./mac/install');
        await installMac();
    } else if (process.platform === 'linux') {
        logger.info('Installing Happy CLI daemon for Linux (systemd user service)...');
        const { install: installLinux } = await import('./linux/install');
        await installLinux();
    } else {
        throw new Error(`Daemon installation is not supported on ${process.platform}`);
    }
}