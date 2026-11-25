import { describe, expect, it } from 'vitest';
import { ApiUpdateSchema } from './apiTypes';

describe('ApiUpdateSchema', () => {
    it('accepts shared wire update-session payload', () => {
        const parsed = ApiUpdateSchema.safeParse({
            t: 'update-session',
            id: 'session-1',
        });
        expect(parsed.success).toBe(true);
    });

    it('accepts app-local new-session payload', () => {
        const parsed = ApiUpdateSchema.safeParse({
            t: 'new-session',
            id: 'session-2',
            createdAt: 1,
            updatedAt: 1,
        });
        expect(parsed.success).toBe(true);
    });

    it('accepts a new-machine registration — the only machine event carrying the wrapped key', () => {
        const parsed = ApiUpdateSchema.safeParse({
            t: 'new-machine',
            machineId: 'machine-1',
            seq: 0,
            metadata: 'encrypted-metadata',
            metadataVersion: 1,
            daemonState: 'encrypted-state',
            daemonStateVersion: 5,
            dataEncryptionKey: 'wrapped-key',
            active: true,
            activeAt: 1,
            createdAt: 1,
            updatedAt: 1,
        });
        expect(parsed.success).toBe(true);
    });
});

