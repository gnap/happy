import type { MarkdownSpan } from "./parseMarkdown";

// Pattern: $$...$$ (1-2), $...$ (3-4), **bold** (5-6), *italic* (7-8), [link](url) (9-11), `code` (12-13)
// Inline math $...$ accepts 1+ non-$ chars (single-char like $x$ now works)
const pattern = /(\$\$([^$]+)\$\$)|(\$([^$\s]?[^$]*?[^$\s]?)\$)|(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))/g;

export function parseMarkdownSpans(markdown: string, header: boolean) {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(markdown)) !== null) {
        // Capture the text between the end of the last match and the start of this match as plain text
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            spans.push({ styles: [], text: plainText, url: null });
        }

        if (match[1]) {
            // Display math: $$...$$
            spans.push({ styles: ['math'], text: match[2], url: null });
        } else if (match[3]) {
            // Inline math: $...$
            spans.push({ styles: ['math'], text: match[4], url: null });
        } else if (match[5]) {
            // Bold
            if (header) {
                spans.push({ styles: [], text: match[6], url: null });
            } else {
                spans.push({ styles: ['bold'], text: match[6], url: null });
            }
        } else if (match[7]) {
            // Italic
            if (header) {
                spans.push({ styles: [], text: match[8], url: null });
            } else {
                spans.push({ styles: ['italic'], text: match[8], url: null });
            }
        } else if (match[9]) {
            // Link - handle incomplete links (no URL part)
            if (match[11]) {
                spans.push({ styles: [], text: match[10], url: match[11] });
            } else {
                // If no URL part, treat as plain text with brackets
                spans.push({ styles: [], text: `[${match[10]}]`, url: null });
            }
        } else if (match[12]) {
            // Inline code
            spans.push({ styles: ['code'], text: match[13], url: null });
        }

        lastIndex = pattern.lastIndex;
    }

    // If there's any text remaining after the last match, treat it as plain
    if (lastIndex < markdown.length) {
        spans.push({ styles: [], text: markdown.slice(lastIndex), url: null });
    }

    return spans;
}