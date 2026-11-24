import { describe, expect, it } from 'vitest';
import { decideSessionDelete } from './sessionDelete';

describe('decideSessionDelete', () => {
    it('takes the machine recording the deletion as the answer', () => {
        expect(decideSessionDelete({ kind: 'applied' })).toEqual({ kind: 'applied' });
    });

    it('falls back to the server only for a machine without the archive route', () => {
        expect(decideSessionDelete({ kind: 'unsupported' })).toEqual({ kind: 'legacy-server' });
    });

    it('reports a refusal as a failure, with the machine\'s reason when it gave one', () => {
        expect(decideSessionDelete({ kind: 'refused', body: 'not yours' }))
            .toEqual({ kind: 'failed', message: 'not yours' });
        // No reason from the machine: the caller's localized failure message is the whole text.
        expect(decideSessionDelete({ kind: 'refused' })).toEqual({ kind: 'failed' });
    });

    it('reports unreachable as a failure rather than keeping the intent', () => {
        // The App has no offline deletion: nothing answered means the person's request did not
        // happen, and the row stays.
        expect(decideSessionDelete({ kind: 'unavailable' })).toEqual({ kind: 'failed' });
    });
});
