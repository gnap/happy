/**
 * The machine's named relay routes: which route names this machine exposes, and on which local
 * port.
 *
 * The route itself — the SOCKS5 hop it stands for, and that hop's credentials — lives on the
 * relay and is never part of this file. What a machine owns is the port, because a port is a
 * machine-local fact: the relay has no business choosing one, and two machines may expose the
 * same route on different ports or not at all.
 *
 * The file is `$HAPPY_HOME_DIR/proxy-routes.json` and is read at daemon startup; changing it means
 * restarting the daemon, which is deliberate — a listener that quietly moved under a running
 * agent would turn a working route into a refused connection with no event between them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { logger } from '@/ui/logger';

export type LocalRoute = {
    /** The route name, as the relay defines it. */
    name: string;
    /** The port this daemon listens on for this route. */
    port: number;
};

/**
 * Reads the file, skipping anything unusable.
 *
 * Malformed entries are dropped one by one rather than failing the daemon: a typo in one route
 * must not take the other routes — or the daemon itself — down with it. What is *not* tolerated is
 * silent reinterpretation: a name that cannot be used simply does not exist afterwards.
 */
export function loadLocalRoutes(filePath: string): LocalRoute[] {
    if (!existsSync(filePath)) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
        logger.warn(`[route] ${filePath} is not valid JSON; no named routes will be served`, { error: String(error) });
        return [];
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn(`[route] ${filePath} must be an object of route name -> port; no routes will be served`);
        return [];
    }
    const routes: LocalRoute[] = [];
    const usedPorts = new Set<number>();
    for (const [rawName, rawPort] of Object.entries(parsed as Record<string, unknown>)) {
        const name = rawName.trim();
        const port = Number(rawPort);
        if (!name) {
            logger.warn('[route] ignoring a route with an empty name');
            continue;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            logger.warn(`[route] ignoring "${name}": ${JSON.stringify(rawPort)} is not a port`);
            continue;
        }
        if (usedPorts.has(port)) {
            logger.warn(`[route] ignoring "${name}": port ${port} is already used by another route`);
            continue;
        }
        usedPorts.add(port);
        routes.push({ name, port });
    }
    return routes;
}
