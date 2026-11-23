import { describe, expect, it } from 'vitest';
import { answerLabels, askUserQuestionAnswers } from './askUserQuestionResult';
import { toolErrorMessage } from './toolErrorText';

describe('askUserQuestionAnswers', () => {
    it('reads the answers out of an answered question result', () => {
        const result = {
            questions: [{ question: 'Deploy?', header: 'Deploy', options: [] }],
            answers: { 'Deploy?': 'Now' },
        };
        expect(askUserQuestionAnswers(result)).toEqual({ 'Deploy?': 'Now' });
    });

    it('is not fooled by a result that merely has an answers-shaped array', () => {
        expect(askUserQuestionAnswers({ answers: ['Now'] })).toBeNull();
    });

    it('returns null for the legacy plain-string result', () => {
        expect(askUserQuestionAnswers('Approved')).toBeNull();
    });
});

describe('answerLabels', () => {
    it('splits a comma-separated answer', () => {
        expect(answerLabels('Now, Later')).toEqual(['Now', 'Later']);
    });

    it('accepts the array shape', () => {
        expect(answerLabels(['Now', 'Later'])).toEqual(['Now', 'Later']);
    });

    it('ignores anything that is not an answer', () => {
        expect(answerLabels(undefined)).toEqual([]);
        expect(answerLabels({ label: 'Now' })).toEqual([]);
    });
});

describe('toolErrorMessage', () => {
    it('keeps a string result as it is', () => {
        expect(toolErrorMessage('boom')).toBe('boom');
    });

    it('does not stringify an object into [object Object]', () => {
        const text = toolErrorMessage({ error: 'permission was canceled' });
        expect(text).toBe('permission was canceled');
        expect(text).not.toContain('[object');
    });

    it('falls back to the structure when it carries no message', () => {
        const text = toolErrorMessage({ questions: [], answers: {} });
        expect(text).toContain('"answers"');
        expect(text).not.toContain('[object');
    });

    it('returns null when there is nothing to show', () => {
        expect(toolErrorMessage(undefined)).toBeNull();
        expect(toolErrorMessage('   ')).toBeNull();
        expect(toolErrorMessage({})).toBeNull();
    });
});
