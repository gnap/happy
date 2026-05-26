import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';

describe('resolveMessageModeMeta', () => {
    it('sends explicit permission and model keys', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'read-only',
            modelMode: 'gpt-5-high',
            metadata: null,
        } as any);

        expect(meta).toEqual({
            permissionMode: 'read-only',
            model: 'gpt-5-high',
        });
    });

    it('forces bypass permissions in sandbox when mode is default', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: { enabled: true },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'bypassPermissions',
            model: null,
        });
    });

    it('keeps default permissions when sandbox is disabled', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'default',
            metadata: {
                sandbox: null,
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'default',
            model: null,
        });
    });

    it('sends maxMode from local override or session metadata', () => {
        expect(resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            maxMode: true,
            metadata: { currentMaxMode: false },
        } as any)).toEqual({
            permissionMode: 'default',
            model: null,
            maxMode: true,
        });

        expect(resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            maxMode: undefined,
            metadata: { currentMaxMode: true },
        } as any)).toEqual({
            permissionMode: 'default',
            model: null,
            maxMode: true,
        });
    });
});
