import { describe, expect, it } from 'vitest';
import { parseMarkdownSpans } from './parseMarkdownSpans';

const stylesOf = (markdown: string, header = false) =>
    parseMarkdownSpans(markdown, header).map((span) => `${span.styles.join('+') || 'plain'}:${span.text}`);

describe('parseMarkdownSpans', () => {
    it('keeps bold when the line starts with a list marker', () => {
        // The reported shape: the leading star opened an italic that ate one star of the bold pair,
        // so the bold came out as plain text.
        expect(stylesOf('* an item with **bold** in it')).toEqual([
            'plain:* an item with ', 'bold:bold', 'plain: in it',
        ]);
    });

    it('keeps bold when an italic sits beside it', () => {
        expect(stylesOf('*italic* and **bold**')).toEqual([
            'italic:italic', 'plain: and ', 'bold:bold',
        ]);
    });

    it('keeps bold inside an italic-free sentence and italic separate from bold', () => {
        expect(stylesOf('a **bold** b *it* c')).toEqual([
            'plain:a ', 'bold:bold', 'plain: b ', 'italic:it', 'plain: c',
        ]);
    });

    it('does not make the rest of the line bold from an unmatched pair', () => {
        // An unclosed delimiter is not a delimiter: it used to swallow everything after it.
        expect(stylesOf('unclosed **bold and then text')).toEqual(['plain:unclosed **bold and then text']);
        expect(stylesOf('unclosed *italic and then text')).toEqual(['plain:unclosed *italic and then text']);
    });

    it('still styles bold, italic and code where they are unambiguous', () => {
        expect(stylesOf('**b** *i* `c`')).toEqual(['bold:b', 'plain: ', 'italic:i', 'plain: ', 'code:c']);
    });

    it('keeps a bold span that contains a literal star', () => {
        // The case that showed the first fix was too strict: `[^*]+` made any bold containing a star
        // fail to match, so only the text before the star stayed bold. A single star is fine inside;
        // only another pair is not.
        expect(stylesOf('**a * b** and text')).toEqual(['bold:a * b', 'plain: and text']);
        expect(stylesOf('**iOS 远端已经被人推过了**')).toEqual(['bold:iOS 远端已经被人推过了']);
    });

    it('leaves a header without emphasis, as before', () => {
        expect(stylesOf('**Title**', true)).toEqual(['plain:Title']);
    });
});
