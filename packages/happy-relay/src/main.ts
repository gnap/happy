import { existsSync, readFileSync } from 'node:fs';
import { startRelay } from './relay';

const certFile = process.env.RELAY_CERT;
const keyFile = process.env.RELAY_KEY;

/**
 * Named egress routes. A file rather than environment variables because a route carries a SOCKS5
 * URL with credentials: one root-owned file with one line per route is easier to audit and to
 * rotate than values scattered through a unit file. Names only are ever sent to a machine.
 */
const routesFile = process.env.RELAY_ROUTES_FILE ?? '/opt/happy-relay/routes.json';
let routes: Record<string, string | null> = {};
if (existsSync(routesFile)) {
    try {
        const parsed: unknown = JSON.parse(readFileSync(routesFile, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (name.trim().length === 0) continue;
                // null means "this route has no hop": the relay dials the target itself.
                if (value === null || typeof value === 'string') routes[name] = value;
            }
        } else {
            console.error(`[relay] ${routesFile} is not an object of route names`);
        }
    } catch (error) {
        console.error(`[relay] could not read ${routesFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const handle = startRelay({
    port: Number(process.env.RELAY_PORT) || 443,
    tls: certFile && keyFile ? { certFile, keyFile } : undefined,
    routes,
});
console.log(`happy-relay listening on :${handle.port}${certFile ? ' (tls)' : ''} routes=${Object.keys(routes).length}`);
