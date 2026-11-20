/**
 * The relay route names a profile editor can offer.
 *
 * Routes are machine-level: each daemon publishes the names it serves, names only. A profile is
 * account-level and may run anywhere, so the picker offers the union of what the known machines
 * publish — plus whatever this profile already stores, so a route on a machine that is offline
 * (or no longer known) is not silently dropped from its own profile.
 *
 * Whether a name is servable on the machine a session lands on is decided there, by the session:
 * a route it does not serve fails closed rather than falling back to a direct connection.
 */
export function collectProxyRoutes(
    machines: Array<{ metadata?: { proxyRoutes?: string[] } | null } | null | undefined>,
    current?: string,
): string[] {
    const names = new Set<string>();
    for (const machine of machines) {
        for (const name of machine?.metadata?.proxyRoutes ?? []) {
            const trimmed = typeof name === 'string' ? name.trim() : '';
            if (trimmed) names.add(trimmed);
        }
    }
    const selected = current?.trim();
    if (selected) names.add(selected);
    return [...names].sort();
}
