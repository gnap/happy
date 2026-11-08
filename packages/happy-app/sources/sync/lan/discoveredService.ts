/**
 * One resolved Bonjour service, turned into an address the rest of the LAN code can use.
 *
 * Kept apart from the browse itself because it is the one place where a browse's answer becomes an
 * address a socket will aim at, and it is worth pinning without a network or a native module.
 */

import type { ZeroconfService } from 'expo-zeroconf';
import type { DiscoveredMachine } from './types';

/** Bonjour hostnames arrive fully qualified, e.g. `my-mac.local.`; the trailing dot breaks URLs. */
function normalizeHost(host: string): string {
    return host.endsWith('.') ? host.slice(0, -1) : host;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Where to reach the service.
 *
 * A resolved IPv4 address when the browse gave one, and the hostname only when it did not. The
 * hostname is a *second* lookup — mDNS again, at the moment something wants a socket — and mDNS is
 * the least dependable thing on a device that has just woken: a browse that resolved the service
 * before a suspension says nothing about whether `X.local.` resolves now, and a socket waiting on
 * that answer is a LAN channel that stays unreached while an address the App already holds would
 * have answered. Every scan refreshes the sighting, so the address is no staler than the name.
 *
 * IPv4 only, because the daemon serves HTTP on one: an IPv6 literal needs brackets in a URL, and
 * the link-local ones a browse returns first are not reachable without a zone.
 */
export function reachableHost(service: ZeroconfService): string | undefined {
    return service.addresses?.find((address) => IPV4.test(address))
        ?? (service.host ? normalizeHost(service.host) : service.addresses?.[0]);
}

/** A service with the identity this account can use, or null for one to skip rather than guess at. */
export function toDiscoveredMachine(service: ZeroconfService): DiscoveredMachine | null {
    const txt = service.txt ?? {};
    const machineId = txt.machineId;
    const host = reachableHost(service);
    const port = service.port;

    // A record without identity or a resolved address is not usable; skip rather than guess.
    if (!machineId || !host || !port) {
        return null;
    }

    const parsedVersion = Number(txt.v);

    return {
        serviceName: service.name,
        machineId,
        accountFingerprint: txt.accountFingerprint ?? '',
        protocolVersion: Number.isFinite(parsedVersion) ? parsedVersion : null,
        host,
        port,
        baseUrl: `http://${host}:${port}`,
    };
}
