/**
 * Utility functions for version comparison and validation
 */

// Minimum required CLI version for full compatibility
export const MINIMUM_CLI_VERSION = '0.10.0';

/**
 * Compare two semantic version strings
 * @param version1 First version to compare
 * @param version2 Second version to compare
 * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1: string, version2: string): number {
    // Handle pre-release versions by stripping suffix (e.g., "0.10.0-1" -> "0.10.0")
    const cleanVersion = (v: string) => v.split('-')[0];
    
    const v1Parts = cleanVersion(version1).split('.').map(Number);
    const v2Parts = cleanVersion(version2).split('.').map(Number);
    
    // Pad with zeros if needed
    const maxLength = Math.max(v1Parts.length, v2Parts.length);
    while (v1Parts.length < maxLength) v1Parts.push(0);
    while (v2Parts.length < maxLength) v2Parts.push(0);
    
    for (let i = 0; i < maxLength; i++) {
        if (v1Parts[i] > v2Parts[i]) return 1;
        if (v1Parts[i] < v2Parts[i]) return -1;
    }
    
    return 0;
}

/**
 * Check if a version meets the minimum requirement
 * @param version Version to check
 * @param minimumVersion Minimum required version (defaults to MINIMUM_CLI_VERSION)
 * @returns true if version >= minimumVersion
 */
export function isVersionSupported(version: string | undefined, minimumVersion: string = MINIMUM_CLI_VERSION): boolean {
    if (!version) return false;
    
    try {
        return compareVersions(version, minimumVersion) >= 0;
    } catch {
        // If version comparison fails, assume it's not supported
        return false;
    }
}

/**
 * Compare two version strings for exact equality (including pre-release/commit hash).
 * Use this to detect when a session was spanwed by a different CLI build than the
 * currently-running daemon — even if the semver parts match.
 */
export function versionsExactMatch(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    return a === b;
}

/**
 * Check whether a session should be restarted to pick up the newer CLI version
 * running on its machine.  Returns true when both versions are known and differ.
 */
export function isSessionRestartRecommended(sessionVersion?: string, machineVersion?: string): boolean {
    if (!sessionVersion || !machineVersion) return false;
    return sessionVersion !== machineVersion;
}

/**
 * Parse version string to extract major, minor, and patch numbers
 * @param version Version string to parse
 * @returns Object with major, minor, and patch numbers, or null if invalid
 */
export function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
    try {
        const cleanVersion = version.split('-')[0];
        const [major, minor, patch] = cleanVersion.split('.').map(Number);
        
        if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
            return null;
        }
        
        return { major, minor, patch };
    } catch {
        return null;
    }
}