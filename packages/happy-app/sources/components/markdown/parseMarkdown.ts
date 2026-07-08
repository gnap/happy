import { parseMarkdownBlock } from "./parseMarkdownBlock"

export type MarkdownBlock = {
    type: 'text'
    content: MarkdownSpan[]
} | {
    type: 'header'
    level: 1 | 2 | 3 | 4 | 5 | 6
    content: MarkdownSpan[]
} | {
    type: 'list',
    items: MarkdownSpan[][]
} | {
    type: 'numbered-list',
    items: { number: number, spans: MarkdownSpan[] }[]
} | {
    type: 'code-block',
    language: string | null,
    content: string
} | {
    type: 'mermaid',
    content: string
} | {
    type: 'svg',
    content: string
} | {
    type: 'horizontal-rule'
} | {
    type: 'options',
    items: string[]
} | {
    type: 'table',
    headers: string[],
    rows: string[][]
} | {
    type: 'math',
    content: string
}

export type MarkdownSpan = {
    styles: ('italic' | 'bold' | 'semibold' | 'code' | 'math')[],
    text: string,
    url: string | null
}

export function parseMarkdown(markdown: string) {
    return parseMarkdownBlock(markdown);
}