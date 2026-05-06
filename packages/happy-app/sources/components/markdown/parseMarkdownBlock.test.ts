import { describe, expect, it } from 'vitest';

import { parseMarkdownBlock } from './parseMarkdownBlock';

describe('parseMarkdownBlock tables', () => {
    it('preserves empty middle cells so later columns stay aligned', () => {
        const blocks = parseMarkdownBlock(`
| col1 | col2 | col3 |
| --- | --- | --- |
| a |  | c |
        `.trim());

        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: ['col1', 'col2', 'col3'],
            rows: [['a', '', 'c']],
        });
    });

    it('preserves empty trailing cells instead of dropping the last column', () => {
        const blocks = parseMarkdownBlock(`
| col1 | col2 | col3 |
| --- | --- | --- |
| a | b |  |
        `.trim());

        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: ['col1', 'col2', 'col3'],
            rows: [['a', 'b', '']],
        });
    });
});
