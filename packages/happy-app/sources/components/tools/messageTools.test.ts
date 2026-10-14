import { describe, expect, it } from 'vitest';
import { sendMessageBody, sendMessageFailure, sendMessageOutcome, sendMessageRecipient, sendMessageTitle } from './messageTools';

describe('reading a SendMessage call', () => {
    it('names the message with display, which is what Claude Code calls it', () => {
        expect(sendMessageTitle({ input: { display: 'Build status', summary: 'build status recap', to: 'spark-21' } }))
            .toBe('Build status');
    });

    it('falls back to the summary, then to the recipient, so a card is never blank', () => {
        expect(sendMessageTitle({ input: { summary: 'build status recap', to: 'spark-21' } })).toBe('build status recap');
        expect(sendMessageTitle({ input: { to: 'spark-21' } })).toBe('spark-21');
        expect(sendMessageTitle({ input: { to: '   ' } })).toBeNull();
    });

    it('takes display from the result too, where a newer CLI puts it', () => {
        expect(sendMessageTitle({ input: { to: 'spark-21' }, result: { display: 'Delivered' } })).toBe('Delivered');
    });

    it('reads the recipient and the body out of the input', () => {
        const tool = { input: { to: 'device-debug-cache-0f [d3a1cd]', message: 'the parser is fixed' } };
        expect(sendMessageRecipient(tool)).toBe('device-debug-cache-0f [d3a1cd]');
        expect(sendMessageBody(tool)).toBe('the parser is fixed');
    });

    it('says what happened to the send in one word', () => {
        expect(sendMessageOutcome('running')).toBe('sending');
        expect(sendMessageOutcome('completed')).toBe('sent');
        expect(sendMessageOutcome('error')).toBe('failed');
    });

    it('gives the reason from a string or a structured failure', () => {
        expect(sendMessageFailure('no such session')).toBe('no such session');
        expect(sendMessageFailure({ error: 'not reachable' })).toBe('not reachable');
        expect(sendMessageFailure({})).toBeNull();
        expect(sendMessageFailure(undefined)).toBeNull();
    });
});
