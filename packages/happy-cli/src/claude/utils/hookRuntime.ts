/**
 * Which binary runs the hook.
 *
 * An explicit `--js-runtime` wins. Otherwise use the runtime already running Happy: Claude Code
 * spawns this as a plain command with the session's PATH, and a host that runs Happy under bun
 * (the Linux daemons) may have no `node` at all — every Stop and SessionStart hook then exited 127
 * and the session silently lost its cron reconciliation and session tracking.
 */
export function hookRuntime(
    jsRuntime?: 'node' | 'bun',
    underBun: boolean = typeof (process.versions as { bun?: string }).bun === 'string',
): 'node' | 'bun' {
    return jsRuntime ?? (underBun ? 'bun' : 'node');
}
