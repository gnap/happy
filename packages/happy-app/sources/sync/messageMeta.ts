import type { Session } from './storageTypes';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import type { AIBackendProfile } from './settings';
import { getProfileEnvironmentVariables } from './settings';
import { getBuiltInProfile } from './profileUtils';

function isSandboxEnabled(metadata: Session['metadata'] | null | undefined): boolean {
    const sandbox = metadata?.sandbox;
    return !!sandbox && typeof sandbox === 'object' && (sandbox as { enabled?: unknown }).enabled === true;
}

export function resolveProfileById(
    profileId: string | null | undefined,
    customProfiles: AIBackendProfile[],
): AIBackendProfile | null {
    if (!profileId) {
        return null;
    }
    return customProfiles.find((p) => p.id === profileId) ?? getBuiltInProfile(profileId);
}

export function resolveMessageProfileEnv(
    session: Pick<Session, 'profileId'>,
    customProfiles: AIBackendProfile[],
): Record<string, string> | undefined {
    const profile = resolveProfileById(session.profileId, customProfiles);
    if (!profile) {
        return undefined;
    }
    const env = getProfileEnvironmentVariables(profile);
    return Object.keys(env).length > 0 ? env : undefined;
}

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'maxMode' | 'metadata'>,
): { permissionMode: PermissionModeKey; model: string | null; maxMode?: boolean } {
    const sandboxEnabled = isSandboxEnabled(session.metadata);
    const permissionMode: PermissionModeKey =
        session.permissionMode && session.permissionMode !== 'default'
            ? session.permissionMode
            : (sandboxEnabled ? 'bypassPermissions' : 'default');

    const modelMode = session.modelMode || 'default';
    const model = modelMode !== 'default' ? modelMode : null;

    const maxMode =
        session.maxMode !== undefined && session.maxMode !== null
            ? session.maxMode
            : session.metadata?.currentMaxMode;

    return {
        permissionMode,
        model,
        ...(maxMode !== undefined ? { maxMode } : {}),
    };
}
