import { SandboxConfig, SandboxConfigSchema } from '@/persistence';

export function extractNoSandboxFlag(args: string[]): { noSandbox: boolean; args: string[] } {
    let noSandbox = false;
    const remainingArgs: string[] = [];

    for (const arg of args) {
        if (arg === '--no-sandbox') {
            noSandbox = true;
        } else {
            remainingArgs.push(arg);
        }
    }

    return {
        noSandbox,
        args: remainingArgs,
    };
}

/**
 * Extract --sandbox-config <base64-json> from CLI args.
 * Returns parsed SandboxConfig or undefined, plus remaining args with the flag consumed.
 */
export function extractSandboxConfigFlag(args: string[]): { sandboxConfig?: SandboxConfig; args: string[] } {
    let sandboxConfig: SandboxConfig | undefined;
    const remainingArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--sandbox-config' && i + 1 < args.length) {
            try {
                const json = Buffer.from(args[i + 1], 'base64').toString('utf-8');
                sandboxConfig = SandboxConfigSchema.parse(JSON.parse(json));
                i++; // consume the value too
            } catch {
                // Invalid base64 or schema — ignore, fall back to settings.json
            }
        } else {
            remainingArgs.push(args[i]);
        }
    }

    return { sandboxConfig, args: remainingArgs };
}
