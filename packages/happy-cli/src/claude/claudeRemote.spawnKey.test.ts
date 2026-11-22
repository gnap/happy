import { describe, expect, it } from 'vitest';
import { stableArgs } from './claudeRemote';

describe('stableArgs', () => {
    it('keeps the flags that stay in effect', () => {
        expect(stableArgs(['--model', 'opus', '--effort', 'high'])).toEqual(['--model', 'opus', '--effort', 'high']);
    });

    it('drops the one-time flags the session consumes after its first spawn', () => {
        // Left in the key, these made the live process look wrong to the very next turn, and every
        // session replaced its process once for a flag that had already done its job.
        expect(stableArgs(['--resume', 'f3b67d90-338d-46a2-8d28-59bff67e9e05', '--model', 'opus']))
            .toEqual(['--model', 'opus']);
        expect(stableArgs(['--continue', '--model', 'opus'])).toEqual(['--model', 'opus']);
        expect(stableArgs(['--resume'])).toEqual([]);
    });

    it('treats absent args as none', () => {
        expect(stableArgs(undefined)).toEqual([]);
    });
});
