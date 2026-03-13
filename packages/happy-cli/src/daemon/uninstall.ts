import { logger } from '@/ui/logger';

export async function uninstall(): Promise<void> {
    if (process.platform === 'darwin') {
        if (process.getuid && process.getuid() !== 0) {
            throw new Error('Daemon uninstallation requires sudo privileges on macOS. Please run with sudo.');
        }
        logger.info('Uninstalling Happy CLI daemon for macOS...');
        const { uninstall: uninstallMac } = await import('./mac/uninstall');
        await uninstallMac();
    } else if (process.platform === 'linux') {
        logger.info('Uninstalling Happy CLI daemon for Linux...');
        const { uninstall: uninstallLinux } = await import('./linux/uninstall');
        await uninstallLinux();
    } else {
        throw new Error(`Daemon uninstallation is not supported on ${process.platform}`);
    }
}