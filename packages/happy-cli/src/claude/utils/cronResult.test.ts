import { describe, expect, it } from 'vitest';
import { cronIdFromCreateResult } from './cronResult';

describe('cronIdFromCreateResult', () => {
    it('reads the job id out of what CronCreate answered', () => {
        // The id the result names is the one CronDelete takes; the tool call's own id is not.
        expect(cronIdFromCreateResult('Scheduled recurring job bcd6a541 (7,37 * * * *). Next run: Nov 3 6:48pm. Session-only (not written to disk, dies when Claude exits).'))
            .toBe('bcd6a541');
        expect(cronIdFromCreateResult('Scheduled one-shot task d983faec (17 13 2 11 *). Next run: Nov 2 1:17pm. Session-only (not written to disk, dies when Claude exits).'))
            .toBe('d983faec');
    });

    it('reads it out of a content-block result too', () => {
        expect(cronIdFromCreateResult([{ type: 'text', text: 'Scheduled recurring job 49eb0be0 (4-59/10 * * * *).' }]))
            .toBe('49eb0be0');
    });

    it('says nothing when the call created nothing', () => {
        // An error or a refusal leaves the provisional entry with no job id to re-key it to; the
        // caller drops that entry rather than displaying a schedule that does not exist.
        expect(cronIdFromCreateResult('Error: invalid cron expression')).toBeNull();
        expect(cronIdFromCreateResult({})).toBeNull();
        expect(cronIdFromCreateResult(undefined)).toBeNull();
    });
});
