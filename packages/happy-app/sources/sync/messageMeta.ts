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
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'maxMode' | 'thinkingLevel' | 'metadata' | 'sandboxIsolation'>,
): { permissionMode: PermissionModeKey; model: string | null; maxMode?: boolean; effort?: string; sandboxIsolation?: string } {
    // Explicit local choice (including 'off') takes priority over stale metadata.
    // This ensures toggling sandbox off immediately affects the permission mode
    // on the next message, even before the CLI processes the metadata update.
    const sandboxEnabled = session.sandboxIsolation != null
        ? session.sandboxIsolation !== 'off'
        : isSandboxEnabled(session.metadata);
    const permissionMode: PermissionModeKey =
        session.permissionMode && session.permissionMode !== 'default'
            ? session.permissionMode
            : (sandboxEnabled ? 'bypassPermissions' : 'default');

    const modelMode = session.modelMode || 'default';
    // When no explicit model is selected, resolve to the effective model from metadata
    // so the CLI's mode hash stays stable across turns (no spurious process restart).
    const model = modelMode !== 'default'
        ? modelMode
        : (session.metadata?.currentModelCode?.trim() || null);

    const maxMode =
        session.maxMode !== undefined && session.maxMode !== null
            ? session.maxMode
            : session.metadata?.currentMaxMode;

    // Resolve effort from persistent local thinkingLevel (explicit user choice).
    // 'auto' and null mean "let the CLI default" — don't send effort.
    const effort =
        session.thinkingLevel && session.thinkingLevel !== 'auto'
            ? session.thinkingLevel
            : undefined;

    // Sandbox isolation: explicit local choice only (not metadata fallback).
    // Local preference is sent with the message; CLI updates metadata,
    // which becomes the source of truth after the turn ends.
    // Must include 'off' explicitly — otherwise the CLI never sees the disable.
    const sandboxIsolation =
        session.sandboxIsolation != null
            ? session.sandboxIsolation
            : undefined;

    return {
        permissionMode,
        model,
        ...(maxMode !== undefined ? { maxMode } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(sandboxIsolation !== undefined ? { sandboxIsolation } : {}),
    };
}
