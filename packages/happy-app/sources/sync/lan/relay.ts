import { LAN_DEFAULT_PORT, type PublishedLanEndpoints, type RelayEndpoint } from './types';

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

/** Where a machine said it can be reached on the local network, from the metadata it publishes. */
export type PublishedLanEndpoint = { machineId: string; baseUrl: string; at: number };

/**
 * What a machine's latest claim does to the address being held.
 *
 * Three outcomes rather than two, because "the machine published nothing about itself" and "the
 * machine published that it has no address" are different facts, and only one of them is a reason to
 * forget what was cached: a blob that parses to nothing is a machine whose metadata is older than
 * this field, while a route the App derived for itself is dropped on purpose.
 */
export type EndpointChange<T> =
    | { kind: 'none' }
    | { kind: 'clear' }
    | { kind: 'set'; endpoint: T };

/**
 * One rule for the LAN address, wherever the claim came from.
 *
 * The server's copy of a machine's metadata and the machine's own log both end up here, and they
 * have to agree: the same claim arriving on two channels must not produce two different addresses,
 * and a machine that republishes the address it already has must not churn the store.
 */
export function advanceLanEndpoint(
    held: { baseUrl: string; at: number } | undefined,
    next: { baseUrl: string; at: number } | null,
): EndpointChange<{ baseUrl: string; at: number }> {
    if (next === null) {
        return held === undefined ? { kind: 'none' } : { kind: 'clear' };
    }
    return held?.baseUrl === next.baseUrl ? { kind: 'none' } : { kind: 'set', endpoint: next };
}

/**
 * The same rule for a relay route.
 *
 * A route is never cleared: the machine going quiet and the machine having none look identical from
 * here, and the cache is for exactly the first of those. `derived` and `published` are both routes,
 * and the published one wins — it is the machine's own claim about itself rather than something this
 * device computed.
 */
export function advanceRelayEndpoint(
    held: RelayEndpoint | undefined,
    next: RelayEndpoint | null,
): EndpointChange<RelayEndpoint> {
    if (next === null) {
        return { kind: 'none' };
    }
    if (held?.baseUrl === next.baseUrl && held.source === next.source) {
        return { kind: 'none' };
    }
    return { kind: 'set', endpoint: next };
}

/**
 * Reads the LAN half of what a machine publishes about itself.
 *
 * The relay half has been read from the same blob for a while (`parseRelayEndpoint`); this is the
 * other half, and it is the one that matters when mDNS cannot be used — a VLAN, an access point
 * that isolates clients, a network with multicast switched off. The address comes from the machine
 * and through the server, so it does not depend on discovery working at all.
 *
 * It is a *hint*, not an authority: an address that no longer answers is dropped like any other
 * sighting, because a machine's address changes without telling anyone. What it buys is that the
 * LAN channel can be used on networks where it could otherwise never be found.
 */
export function parseLanEndpoint(machineId: string, daemonState: unknown): PublishedLanEndpoint | null {
    const p2p = (daemonState as { p2p?: Partial<PublishedLanEndpoints> } | null)?.p2p;
    if (!p2p || !Array.isArray(p2p.endpoints)) {
        return null;
    }
    for (const endpoint of p2p.endpoints) {
        if (endpoint?.t !== 'lan' && endpoint?.t !== 'ipv6') {
            continue;
        }
        if (typeof endpoint.addr !== 'string' || endpoint.addr.length === 0) {
            continue;
        }
        const port = typeof endpoint.port === 'number' && endpoint.port > 0 ? endpoint.port : LAN_DEFAULT_PORT;
        return { machineId, baseUrl: `http://${endpoint.addr}:${port}`, at: typeof p2p.at === 'number' ? p2p.at : Date.now() };
    }
    return null;
}
