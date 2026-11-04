import { describe, expect, it } from 'vitest';
import { hookRuntime } from './hookRuntime';

describe('hookRuntime', () => {
    it('honours an explicit --js-runtime', () => {
        expect(hookRuntime('node', true)).toBe('node');
        expect(hookRuntime('bun', false)).toBe('bun');
    });

    it('otherwise uses the runtime already running Happy', () => {
        // Claude Code runs the hook with the session's PATH. On the Linux daemons that is a
        // bun-only machine, so a hardcoded `node` exited 127 on every Stop and SessionStart hook.
        expect(hookRuntime(undefined, true)).toBe('bun');
        expect(hookRuntime(undefined, false)).toBe('node');
    });
});
