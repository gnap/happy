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

/**
 * Where a machine said it can be reached on the local network, from the metadata it publishes.
 *
 * A list, in the order the machine ranked it. The machine is the one that knows which of its
 * interfaces it is reachable on, so its order is kept rather than re-derived here — and when one
 * address does not answer, the next one is a real alternative rather than nothing.
 */
export type PublishedLanAddresses = { machineId: string; baseUrls: string[]; at: number };

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
    held: { baseUrls: string[]; at: number } | undefined,
    next: { baseUrls: string[]; at: number } | null,
): EndpointChange<{ baseUrls: string[]; at: number }> {
    if (next === null) {
        // A blob that names no address is a machine that has stopped claiming one — a rebuild that
        // took the field away, or an interface check that now excludes everything it used to offer.
        // The cached list goes, because nothing is claiming it any more.
        return held === undefined ? { kind: 'none' } : { kind: 'clear' };
    }
    // The whole ordered list is the claim, so a republish of the same set says nothing new even
    // though it arrives with a later `at`.
    return sameBaseUrls(held?.baseUrls, next.baseUrls) ? { kind: 'none' } : { kind: 'set', endpoint: next };
}

function sameBaseUrls(a: readonly string[] | undefined, b: readonly string[]): boolean {
    return a !== undefined && a.length === b.length && a.every((url, index) => url === b[index]);
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
export function parseLanEndpoints(machineId: string, daemonState: unknown): PublishedLanAddresses | null {
    const p2p = (daemonState as { p2p?: Partial<PublishedLanEndpoints> } | null)?.p2p;
    if (!p2p || !Array.isArray(p2p.endpoints)) {
        return null;
    }
    const baseUrls: string[] = [];
    for (const endpoint of p2p.endpoints) {
        if (endpoint?.t !== 'lan' && endpoint?.t !== 'ipv6') {
            continue;
        }
        if (typeof endpoint.addr !== 'string' || endpoint.addr.length === 0) {
            continue;
        }
        const port = typeof endpoint.port === 'number' && endpoint.port > 0 ? endpoint.port : LAN_DEFAULT_PORT;
        // An IPv6 address has to be bracketed in a URL, or the port reads as part of the address and
        // the result is not a URL at all. The v6 half of the published list never worked without it.
        const host = endpoint.addr.includes(':') ? `[${endpoint.addr}]` : endpoint.addr;
        const baseUrl = `http://${host}:${port}`;
        if (!baseUrls.includes(baseUrl)) {
            baseUrls.push(baseUrl);
        }
    }
    if (baseUrls.length === 0) {
        return null;
    }
    return { machineId, baseUrls, at: typeof p2p.at === 'number' ? p2p.at : Date.now() };
}

