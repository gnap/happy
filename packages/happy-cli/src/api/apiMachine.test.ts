import { describe, expect, it } from 'vitest';
import { buildSyncedMachineMetadata, shouldSyncMachineMetadata } from './apiMachine';
import type { MachineMetadata } from './types';

const baseMetadata: MachineMetadata = {
    host: 'old-host',
    platform: 'linux',
    happyCliVersion: '0.14.0-0',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/user/anjiangze/Projects/happy',
};

const localMetadata: MachineMetadata = {
    host: 'new-host',
    platform: 'linux',
    happyCliVersion: '0.14.0-0',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/user/anjiangze/Projects/happy',
};

describe('machine metadata synchronization helpers', () => {
    it('detects when static machine metadata changed', () => {
        expect(shouldSyncMachineMetadata(baseMetadata, localMetadata)).toBe(true);
        expect(shouldSyncMachineMetadata(baseMetadata, baseMetadata)).toBe(false);
    });

    it('treats missing metadata as needing sync', () => {
        expect(shouldSyncMachineMetadata(null, localMetadata)).toBe(true);
    });

    it('preserves extra fields while refreshing static metadata', () => {
        const current = {
            ...baseMetadata,
            displayName: 'My MacBook',
        } as MachineMetadata & { displayName?: string };

        const synced = buildSyncedMachineMetadata(current, localMetadata) as MachineMetadata & { displayName?: string };

        expect(synced).toEqual({
            ...localMetadata,
            displayName: 'My MacBook',
        });
    });
});
