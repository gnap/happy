import type { PublishedLanEndpoints, RelayEndpoint } from './types';

const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const TAG_RE = /^[0-9a-f]{32}$/;

/**
 * Picks the relay route out of a machine's decrypted `daemonState`, or null when it publishes none.
 *
 * `daemonState` is written by the daemon and stored by the server as an opaque blob, so it is
 * validated field by field: a malformed or hostile value must not become a URL the App fetches.
 */
export function parseRelayEndpoint(machineId: string, daemonState: unknown): RelayEndpoint | null {
    const p2p = (daemonState as { p2p?: Partial<PublishedLanEndpoints> } | null)?.p2p;
    if (!p2p || !Array.isArray(p2p.endpoints)) {
        return null;
    }
    for (const endpoint of p2p.endpoints) {
        if (endpoint?.t !== 'relay') {
            continue;
        }
        const { addr, port, tag } = endpoint;
        if (typeof addr !== 'string' || !HOST_RE.test(addr) || typeof tag !== 'string' || !TAG_RE.test(tag)) {
            continue;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            continue;
        }
        const authority = port === 443 ? addr : `${addr}:${port}`;
        return {
            machineId,
            baseUrl: `https://${authority}/r/${tag}`,
            // The machine's own claim about itself, which is the only thing that says a relay client
            // is running there.
            source: 'published',
            at: typeof p2p.at === 'number' ? p2p.at : Date.now(),
        };
    }
    return null;
}
