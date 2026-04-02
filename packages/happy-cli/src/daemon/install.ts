import { logger } from '@/ui/logger';
import { install as installMac } from './mac/install';

export async function install(): Promise<void> {
    if (process.platform !== 'darwin') {
        throw new Error('Daemon installation is currently only supported on macOS');
    }

    logger.info('Installing Happy CLI daemon for macOS...');
    await installMac();
}