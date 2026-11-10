import { describe, expect, it } from 'vitest';
import { filePathFromInlineCode } from './filePathSpans';

describe('filePathFromInlineCode', () => {
    it('recognises the paths the agent writes', () => {
        expect(filePathFromInlineCode('src/sync/sync.ts')).toBe('src/sync/sync.ts');
        expect(filePathFromInlineCode('README.md')).toBe('README.md');
        expect(filePathFromInlineCode('./packages/happy-app/package.json')).toBe('packages/happy-app/package.json');
        expect(filePathFromInlineCode('/Users/gnap/report.pdf')).toBe('/Users/gnap/report.pdf');
        expect(filePathFromInlineCode('docs/README')).toBe('docs/README');
    });

    it('drops a line or column suffix, which names a place inside the same file', () => {
        expect(filePathFromInlineCode('src/sync/sync.ts:1535')).toBe('src/sync/sync.ts');
        expect(filePathFromInlineCode('src/sync/sync.ts:1535:21')).toBe('src/sync/sync.ts');
    });

    it('leaves prose, commands and URLs alone', () => {
        expect(filePathFromInlineCode('git status')).toBeNull();
        expect(filePathFromInlineCode('https://example.com/a.md')).toBeNull();
        expect(filePathFromInlineCode('true/false')).toBeNull();
        expect(filePathFromInlineCode('src/components')).toBeNull();
        expect(filePathFromInlineCode('main')).toBeNull();
        expect(filePathFromInlineCode('--force')).toBeNull();
        expect(filePathFromInlineCode('v1.2.3')).toBeNull();
    });

    it('refuses what cannot be a path at all', () => {
        expect(filePathFromInlineCode('')).toBeNull();
        expect(filePathFromInlineCode('a b/c.ts')).toBeNull();
        expect(filePathFromInlineCode('src/*.ts')).toBeNull();
        expect(filePathFromInlineCode('~/secret.md')).toBeNull();
        expect(filePathFromInlineCode('x'.repeat(400) + '.ts')).toBeNull();
    });
});
