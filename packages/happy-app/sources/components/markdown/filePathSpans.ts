/**
 * Whether an inline-code span on a message names a file in the session's working tree.
 *
 * The agent writes paths the way a person reads them — `` `src/sync/sync.ts` ``, `` `README.md` ``,
 * sometimes with a line number — and the App has everything it needs to open one, but nothing
 * turned the text into something to press. This is the recognition half, kept pure so the rules
 * are testable without a message or a renderer.
 *
 * Deliberately conservative: a false positive is a piece of prose that opens an error screen, so
 * a candidate needs either a directory part or a known file extension, and anything with a space,
 * a URL, or shell punctuation is prose about code rather than a path.
 */

const KNOWN_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
    'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1',
    'md', 'mdx', 'txt', 'rst', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'lock',
    'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'sql', 'graphql', 'gql', 'proto',
    'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
    'mp4', 'mov', 'webm', 'mp3', 'wav',
    'zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'dmg',
    'plist', 'pbxproj', 'gradle', 'mk', 'cmake', 'env',
]);

/** Files people name without an extension, and that are worth opening. */
const KNOWN_NAMES = new Set([
    'README', 'LICENSE', 'LICENCE', 'Makefile', 'Dockerfile', 'Procfile', 'Justfile',
    '.gitignore', '.gitattributes', '.npmrc', '.nvmrc', '.env', '.env.local',
]);

const UNSAFE = /[\s<>*?|"'`:;,()[\]{}]/;

export function filePathFromInlineCode(raw: string): string | null {
    const text = raw.trim();
    if (!text || text.length > 300) {
        return null;
    }
    if (text.includes('://')) {
        return null;
    }
    // `src/a.ts:12` and `src/a.ts:12:5` point at a location inside a file, which is the file.
    // Stripped before the punctuation check, because the suffix itself is full of colons.
    const withoutLocation = text.replace(/(?::\d+){1,2}$/, '');
    // Prose about code ("run `git status`", "the `foo bar` case") is not a path.
    if (UNSAFE.test(withoutLocation)) {
        return null;
    }
    const candidate = withoutLocation.replace(/^\.\//, '');
    if (!candidate || candidate.startsWith('~')) {
        return null;
    }
    const base = candidate.split('/').pop() ?? '';
    if (!base) {
        return null;
    }
    const extension = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
    const named = KNOWN_EXTENSIONS.has(extension) || KNOWN_NAMES.has(base);
    if (!named) {
        return null;
    }
    // A trailing slash is a directory, and directories are not opened in the file viewer.
    if (candidate.endsWith('/')) {
        return null;
    }
    return candidate;
}
