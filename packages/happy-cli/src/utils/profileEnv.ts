import { expandEnvironmentVariables } from '@/utils/expandEnvVars';

/** Env prefixes owned by AI backend profiles (cleared before applying profile vars). */
const PROFILE_MANAGED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_'] as const;

export function isProfileManagedEnvKey(key: string): boolean {
    return PROFILE_MANAGED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Remove profile-managed keys so daemon/shell defaults do not leak through partial profile updates. */
export function stripProfileManagedEnv(
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || isProfileManagedEnvKey(key)) {
            continue;
        }
        result[key] = value;
    }
    return result;
}

/**
 * Merge spawn/profile env: strip managed keys from base, expand profile vars, overlay profile on top.
 */
export function mergeProfileIntoEnv(
    baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
    profileEnv: Record<string, string>,
    expandSource?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
    const expanded = expandEnvironmentVariables(profileEnv, expandSource ?? baseEnv);
    return { ...stripProfileManagedEnv(baseEnv), ...expanded };
}

/** Apply profile env to the current process (per-turn), replacing prior managed keys. */
export function applyProfileEnvToProcess(profileEnv: Record<string, string>): void {
    for (const key of Object.keys(process.env)) {
        if (isProfileManagedEnvKey(key)) {
            delete process.env[key];
        }
    }
    const expanded = expandEnvironmentVariables(profileEnv, process.env);
    Object.assign(process.env, expanded);
}
