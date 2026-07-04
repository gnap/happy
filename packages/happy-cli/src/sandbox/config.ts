import { homedir, tmpdir, platform } from 'node:os';
import { isAbsolute, resolve, join } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';

/** Platform-specific temp/cache directories that CLI tools (Claude, bash, node, bun) need write access to. */
function getPlatformTempPaths(): string[] {
    const home = homedir();
    const paths: string[] = [];

    // System temp dirs (all platforms)
    const sysTmp = tmpdir();
    // On macOS, tmpdir() returns a per-user dir like /var/folders/xx/yy/T/
    // Add both the T dir itself and its parent for subpath matching
    if (platform() === 'darwin') {
        const match = sysTmp.match(/^(\/(private\/)?var\/folders\/[^/]{2}\/[^/]+)\/T\/?$/);
        if (match) {
            paths.push(match[1]);              // /var/folders/xx/yy (parent)
            paths.push('/private' + match[1]); // /private/var/folders/xx/yy
            // Also add the T directory itself including /private variant
            paths.push(match[1] + '/T');
            paths.push('/private' + match[1] + '/T');
        }
    }
    paths.push(sysTmp);                  // $TMPDIR
    paths.push('/tmp');                  // always allow /tmp
    paths.push('/private/tmp');          // macOS /tmp -> /private/tmp symlink

    // Cache dirs (platform-specific)
    if (platform() === 'darwin') {
        paths.push(join(home, 'Library/Caches'));
    } else if (platform() === 'linux') {
        paths.push(join(home, '.cache'));
    }

    // Node/npm cache (commonly needed by build tools)
    paths.push(join(home, '.npm'));

    // Bun cache
    if (platform() === 'darwin') {
        paths.push(join(home, 'Library/Caches/bun'));
    }

    return paths;
}

function expandPath(pathValue: string, sessionPath: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }

    return resolve(sessionPath, expandedHome);
}

function resolvePaths(paths: string[], sessionPath: string): string[] {
    return paths.map((pathValue) => expandPath(pathValue, sessionPath));
}

function getSharedAgentStatePaths(sessionPath: string): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';
    const happyHome = process.env.HAPPY_HOME_DIR || '~/.happy';

    return [
        expandPath(codexHome, sessionPath),
        expandPath(claudeConfigDir, sessionPath),
        expandPath(happyHome, sessionPath),
    ];
}

function uniquePaths(paths: string[]): string[] {
    return [...new Set(paths)];
}

export function buildSandboxRuntimeConfig(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
): SandboxRuntimeConfig {
    const extraWritePaths = resolvePaths(sandboxConfig.extraWritePaths, sessionPath);
    const sharedAgentStatePaths = getSharedAgentStatePaths(sessionPath);

    const platformTempPaths = getPlatformTempPaths();
    const allowWrite = (() => {
        switch (sandboxConfig.sessionIsolation) {
            case 'strict':
                return uniquePaths([resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths, ...platformTempPaths]);
            case 'workspace': {
                const workspaceRoot = sandboxConfig.workspaceRoot
                    ? expandPath(sandboxConfig.workspaceRoot, sessionPath)
                    : resolve(sessionPath);
                return uniquePaths([workspaceRoot, resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths, ...platformTempPaths]);
            }
            case 'custom':
                return uniquePaths([
                    ...resolvePaths(sandboxConfig.customWritePaths, sessionPath),
                    ...extraWritePaths,
                    ...sharedAgentStatePaths,
                    ...platformTempPaths,
                ]);
        }
    })();

    const network = (() => {
        switch (sandboxConfig.networkMode) {
            case 'blocked':
                return {
                    allowedDomains: [] as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'allowed':
                return {
                    allowedDomains: undefined as unknown as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'custom':
                return {
                    allowedDomains: sandboxConfig.allowedDomains,
                    deniedDomains: sandboxConfig.deniedDomains,
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
        }
    })();

    const enableWeakerNetworkIsolation = sandboxConfig.networkMode === 'allowed'
        ? true
        : undefined;

    return {
        allowPty: true,
        enableWeakerNetworkIsolation,
        network,
        filesystem: {
            denyRead: resolvePaths(sandboxConfig.denyReadPaths, sessionPath),
            allowWrite,
            denyWrite: resolvePaths(sandboxConfig.denyWritePaths, sessionPath),
        },
    };
}
