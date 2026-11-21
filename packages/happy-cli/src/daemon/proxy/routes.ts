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
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';

export type LocalRoute = {
    /** The route name, as the relay defines it. */
    name: string;
    /** The port this daemon listens on for this route. */
    port: number;
    /**
     * The hosts this route covers. Absent means every host: the listener is then a plain
     * "everything through here" proxy. Given, everything else is dialled from this machine — which
     * is what keeps an agent's paper fetches and web searches off a hop chosen for the model API.
     */
    only?: string[];
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
    for (const [rawName, rawSpec] of Object.entries(parsed as Record<string, unknown>)) {
        const name = rawName.trim();
        if (!name) {
            logger.warn('[route] ignoring a route with an empty name');
            continue;
        }
        // Two shapes: `"name": 57315` for everything, or `"name": { "port": 57315, "only": [...] }`
        // to name the hosts the route is for.
        const spec = rawSpec && typeof rawSpec === 'object' && !Array.isArray(rawSpec)
            ? rawSpec as { port?: unknown; only?: unknown }
            : { port: rawSpec };
        const port = Number(spec.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            logger.warn(`[route] ignoring "${name}": ${JSON.stringify(spec.port)} is not a port`);
            continue;
        }
        let only: string[] | undefined;
        if (spec.only !== undefined) {
            if (!Array.isArray(spec.only) || spec.only.some((host) => typeof host !== 'string' || host.trim().length === 0)) {
                logger.warn(`[route] ignoring "${name}": "only" must be a list of host names`);
                continue;
            }
            only = spec.only.map((host) => host.trim());
        }
        if (usedPorts.has(port)) {
            logger.warn(`[route] ignoring "${name}": port ${port} is already used by another route`);
            continue;
        }
        usedPorts.add(port);
        routes.push({ name, port, ...(only ? { only } : {}) });
    }
    return routes;
}

/**
 * The route names this machine serves, for the machine metadata an App reads.
 *
 * Names only, and only when there is something to say: a machine that serves no routes publishes
 * nothing rather than an empty list, which keeps older App builds from having to understand a new
 * field just to learn there is nothing in it.
 */
export function localRouteNames(): string[] {
    return loadLocalRoutes(join(configuration.happyHomeDir, 'proxy-routes.json')).map((route) => route.name);
}
