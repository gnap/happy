import { describe, expect, it } from 'vitest';
import { parseVersionArtifact, versionStateOf } from './versionState';

const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null;

describe('versionStateOf', () => {
    it('says nothing is wrong when the artifact holds the build that is running', () => {
        const state = versionStateOf('0.14.0-abc1234', ['dist/version.json'], reader({ 'dist/version.json': '{"version":"0.14.0-abc1234"}' }));
        expect(state).toEqual({ running: '0.14.0-abc1234', onDisk: '0.14.0-abc1234', restartRequired: false });
    });

    it('asks for a restart when the artifact holds a different build', () => {
        const state = versionStateOf('0.14.0-abc1234', ['dist/version.json'], reader({ 'dist/version.json': '{"version":"0.14.0-def5678"}' }));
        expect(state.restartRequired).toBe(true);
        expect(state.onDisk).toBe('0.14.0-def5678');
    });

    it('reads the generated source when the build left no json', () => {
        const state = versionStateOf('0.14.0-abc1234', ['dist/version.json', 'src/version.ts'], reader({ 'src/version.ts': 'export const BUILD_VERSION = "0.14.0-abc1234";\n' }));
        expect(state).toEqual({ running: '0.14.0-abc1234', onDisk: '0.14.0-abc1234', restartRequired: false });
    });

    it('treats unreadable or unparsable artifacts as unknown, not as stale', () => {
        // A machine that cannot be read must not be told to restart: a false alarm is how a mark
        // stops meaning anything.
        expect(versionStateOf('0.14.0-abc1234', ['dist/version.json'], reader({})).restartRequired).toBe(false);
        expect(versionStateOf('0.14.0-abc1234', ['dist/version.json'], reader({ 'dist/version.json': 'not json' })).onDisk).toBeNull();
    });

    it('parses either artifact shape', () => {
        expect(parseVersionArtifact('dist/version.json', '{"version":"1.2.3-abcd"}')).toBe('1.2.3-abcd');
        expect(parseVersionArtifact('src/version.ts', 'export const BUILD_VERSION = "1.2.3-abcd";')).toBe('1.2.3-abcd');
        expect(parseVersionArtifact('src/version.ts', 'nothing here')).toBeNull();
    });
});
