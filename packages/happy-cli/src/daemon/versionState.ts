/**
 * Whether the build this process is running is the build that is on disk.
 *
 * A daemon keeps the code it started with, so rebuilding the bundle under it changes nothing until
 * it is restarted — and nothing says so: the version it reports, the version a session reports and
 * the version in the file on disk are three different things that *look* like one fact, which is
 * how a machine ends up running one build while everything about it claims another.
 *
 * The daemon is the only party that can settle it, because it is the only one that knows both what
 * it is running and what is on disk. This is that comparison, as a function of a reader, so it can
 * be tested without a filesystem.
 */

export type VersionState = {
    /** The build this process is running. */
    running: string;
    /** The build the artifacts on disk hold, or null when there are none to read. */
    onDisk: string | null;
    /** True only when the two are known and differ. */
    restartRequired: boolean;
};

/** A build artifact that names its build: `dist/version.json`, or the generated `src/version.ts`. */
export function parseVersionArtifact(path: string, contents: string): string | null {
    if (path.endsWith('.json')) {
        try {
            const version = (JSON.parse(contents) as { version?: unknown })?.version;
            return typeof version === 'string' && version.length > 0 ? version : null;
        } catch {
            return null;
        }
    }
    const match = /BUILD_VERSION\s*=\s*["']([^"']+)["']/.exec(contents);
    return match ? match[1] : null;
}

/**
 * The comparison, given the paths to try and a way to read them.
 *
 * Unknown is not "stale": a machine whose artifacts cannot be read must not be told to restart, and
 * a false alarm here teaches people to ignore the mark.
 */
export function versionStateOf(
    running: string,
    candidates: readonly string[],
    read: (path: string) => string | null,
): VersionState {
    for (const path of candidates) {
        const contents = read(path);
        if (contents === null) {
            continue;
        }
        const onDisk = parseVersionArtifact(path, contents);
        if (onDisk !== null) {
            return { running, onDisk, restartRequired: onDisk !== running };
        }
    }
    return { running, onDisk: null, restartRequired: false };
}
