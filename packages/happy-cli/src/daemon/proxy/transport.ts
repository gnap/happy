/**
 * The ways the daemon can carry a session's traffic off this machine.
 *
 * The profile picks the route. A relay route is a byte pipe through the relay: the relay either
 * connects to the profile's SOCKS5 hop, when there is one, or dials the target itself. A direct
 * route dials the hop from this daemon and speaks SOCKS5 over it; it exists only when the profile
 * names a hop, because without one there is nothing to dial.
 *
 * A failure in either is a failure to open the tunnel, never a silent fallback to the other.
 * Falling back would be the one thing worse than failing: the request would leave through an
 * address the profile did not choose.
 */
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { RelayClientHandle } from '@/daemon/relay/relayClient';
import { parseSocks5Url, socks5Connect } from './socks5';

export type ProxyRoute = {
    /** The profile's SOCKS5 URL, credentials included; never logged. */
    socks5?: string;
    /** Carry the session through the relay instead of dialling anything from this machine. */
    viaRelay: boolean;
    /**
     * The relay's own named route. The relay holds the hop this route stands for and performs the
     * SOCKS5 handshake itself, so neither this process nor the agent learns where it goes. Set on
     * the daemon's fixed-port listeners, which are not tied to any session.
     */
    relayRoute?: string;
    /**
     * The only destinations this route covers. Everything else is dialled from this machine.
     *
     * A route moves one conversation's exit — the model API's — not the whole machine's traffic.
     * An agent that fetches a paper, clones a repository or searches the web is doing something
     * the hop was never chosen for; sending that through the hop makes it slower, and can make it
     * fail where the hop has no route. Entries match a host exactly, or a domain when written
     * with a leading dot (`.example.com` covers `api.example.com`).
     */
    only?: string[];
    /** Session tag for logs, so a stream can be attributed without naming the address. */
    label?: string;
};

const DIRECT_CONNECT_TIMEOUT_MS = 10_000;

/** Whether `host` is one this route was chosen for. */
export function routeCovers(route: ProxyRoute, host: string): boolean {
    if (!route.only || route.only.length === 0) return true;
    const name = host.trim().toLowerCase();
    return route.only.some((pattern) => {
        const wanted = pattern.trim().toLowerCase();
        if (!wanted) return false;
        if (wanted.startsWith('.')) return name === wanted.slice(1) || name.endsWith(wanted);
        return name === wanted;
    });
}

export async function openTunnel(
    route: ProxyRoute,
    host: string,
    port: number,
    relay: () => RelayClientHandle | null,
): Promise<Duplex> {
    if (!routeCovers(route, host)) {
        // Not this route's traffic: the machine dials it, through the machine's own network.
        return connectDirect(host, port);
    }
    if (route.relayRoute) {
        // The relay owns the whole path to the hop, including the handshake. What arrives here is
        // already the target's stream, which is why nothing below this point runs for it.
        const client = relay();
        if (!client) throw new Error('the relay is not available');
        return client.openEgress(host, port, route.relayRoute);
    }
    if (!route.socks5) {
        // No hop: the relay is the egress. It resolves the name and connects to the target, so
        // the bytes the agent writes are the bytes the origin sees.
        if (!route.viaRelay) throw new Error('the route names no SOCKS5 hop and does not use the relay');
        const client = relay();
        if (!client) throw new Error('the relay is not available');
        return client.openEgress(host, port);
    }

    const endpoint = parseSocks5Url(route.socks5);
    if (!endpoint) throw new Error('the profile does not contain a valid SOCKS5 address');

    let raw: Duplex;
    if (route.viaRelay) {
        const client = relay();
        if (!client) throw new Error('the relay is not available');
        raw = await client.openEgress(endpoint.host, endpoint.port);
    } else {
        raw = await connectDirect(endpoint.host, endpoint.port);
    }

    try {
        await socks5Connect(raw, host, port, endpoint);
    } catch (error) {
        raw.destroy();
        throw error;
    }
    return raw;
}

function connectDirect(host: string, port: number): Promise<Duplex> {
    return new Promise<Duplex>((resolve, reject) => {
        const socket = connect({ host, port });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('connect to the SOCKS5 hop timed out'));
        }, DIRECT_CONNECT_TIMEOUT_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.removeListener('error', onError);
            // A later error must surface through the caller's handler rather than as an unhandled
            // 'error' event in the window before it attaches one.
            socket.on('error', () => { /* the tunnel owner observes it through close */ });
            resolve(socket);
        });
        const onError = (error: Error) => {
            clearTimeout(timer);
            reject(error);
        };
        socket.once('error', onError);
    });
}
