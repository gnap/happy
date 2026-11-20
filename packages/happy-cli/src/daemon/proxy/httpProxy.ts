/**
 * The loopback HTTP proxy an agent is pointed at through `HTTP_PROXY`/`HTTPS_PROXY`.
 *
 * It exists because the agent has no way to speak SOCKS5 or to ride the relay: both are the
 * daemon's business. The agent gets a plain HTTP proxy on 127.0.0.1, and this translates its
 * CONNECT tunnels — and the less common absolute-form HTTP requests — into the route the profile
 * chose: a byte pipe through the relay (which dials the target, or the profile's SOCKS5 hop when
 * there is one), or a SOCKS5 CONNECT over a connection from this machine.
 *
 * The proxy is per-machine, but the route is per-session: the URL carries a token minted for one
 * session, and a request whose token has no route is refused rather than served with a default.
 * That is the fail-closed rule in one place. There is no direct fallback here: if the relay is
 * unavailable and the route says `viaRelay`, the request fails; sending it out another way would
 * be a request leaving from an address the profile did not choose.
 *
 * Raw `net` parsing rather than an HTTP framework: a CONNECT tunnel is opaque bytes after the
 * handshake, and an absolute-form request must be forwarded byte-for-byte, not re-encoded by a
 * framework that has already parsed the body.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { logger } from '@/ui/logger';
import type { RelayClientHandle } from '@/daemon/relay/relayClient';
import { openTunnel, type ProxyRoute } from './transport';

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_TUNNELS = 64;
const HEADER_TIMEOUT_MS = 30_000;

/** Headers that belong to one hop and must not be forwarded to the next. */
const HOP_HEADERS = new Set([
    'proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
]);

const REASONS: Record<number, string> = {
    400: 'Bad Request',
    413: 'Payload Too Large',
    431: 'Request Header Fields Too Large',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
};

export type LocalProxyHandle = {
    port: number;
    stop: () => Promise<void>;
};

export function startLocalProxy(options: {
    /** The route minted for a token, or null when this session has no proxy configured. */
    getRoute?: (token: string) => ProxyRoute | null;
    /**
     * One route for every request on this listener, with no token. Used for a named relay route's
     * fixed port: the route is the same for every process, so there is nothing to select and
     * nothing to authenticate beyond the loopback binding itself.
     */
    fixedRoute?: ProxyRoute;
    /** Fixed port for a named route; 0 (the default) lets the OS choose a session's port. */
    port?: number;
    relay: () => RelayClientHandle | null;
}): Promise<LocalProxyHandle> {
    const sockets = new Set<Socket>();
    let active = 0;

    const server: Server = createServer({ allowHalfOpen: true }, (client) => {
        if (active >= MAX_TUNNELS) {
            client.destroy();
            return;
        }
        active++;
        sockets.add(client);
        client.on('close', () => {
            active--;
            sockets.delete(client);
        });
        client.on('error', () => { /* the close handler cleans up */ });
        client.setTimeout(HEADER_TIMEOUT_MS, () => client.destroy());

        let buffered: Buffer = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
            const end = buffered.indexOf('\r\n\r\n');
            if (end < 0) {
                if (buffered.length > MAX_HEADER_BYTES) {
                    client.off('data', onData);
                    deny(client, 431, 'request header too large');
                }
                return;
            }
            client.off('data', onData);
            client.setTimeout(0);
            const header = buffered.subarray(0, end).toString('latin1');
            const early = buffered.subarray(end + 4);
            void handleRequest(client, header, early).catch((error: unknown) => {
                logger.debug(`[proxy] request failed: ${error instanceof Error ? error.message : String(error)}`);
                client.destroy();
            });
        };
        client.on('data', onData);
    });

    return new Promise<LocalProxyHandle>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            server.on('error', (error) => logger.debug(`[proxy] server error: ${error.message}`));
            resolve({
                port: (server.address() as { port: number }).port,
                stop: () => new Promise<void>((done) => {
                    for (const socket of sockets) socket.destroy();
                    sockets.clear();
                    server.close(() => done());
                }),
            });
        });
    });

    async function handleRequest(client: Socket, header: string, early: Buffer): Promise<void> {
        const lines = header.split('\r\n');
        const requestLine = lines[0] ?? '';
        const firstSpace = requestLine.indexOf(' ');
        const lastSpace = requestLine.lastIndexOf(' ');
        if (firstSpace <= 0 || lastSpace <= firstSpace) {
            deny(client, 400, 'malformed request line');
            return;
        }
        const method = requestLine.slice(0, firstSpace);
        const target = requestLine.slice(firstSpace + 1, lastSpace);
        const version = requestLine.slice(lastSpace + 1);
        if (!version.startsWith('HTTP/')) {
            deny(client, 400, 'unsupported protocol');
            return;
        }

        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
            const colon = line.indexOf(':');
            if (colon <= 0) continue;
            const key = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`;
        }

        const token = proxyToken(headers['proxy-authorization']);
        const route = options.fixedRoute ?? (token ? options.getRoute?.(token) ?? null : null);
        if (!route) {
            deny(client, 502, 'proxy not configured for this session');
            return;
        }

        if (method.toUpperCase() === 'CONNECT') {
            const authority = splitAuthority(target);
            if (!authority) {
                deny(client, 400, 'malformed CONNECT target');
                return;
            }
            const tunnel = await open(route, authority.host, authority.port);
            if (!tunnel) {
                deny(client, 502, 'could not open a tunnel to the target');
                return;
            }
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (early.length > 0) tunnel.write(early);
            bridge(client, tunnel);
            return;
        }

        let url: URL;
        try {
            url = new URL(target);
        } catch {
            deny(client, 400, 'expected an absolute URL');
            return;
        }
        if (url.protocol !== 'http:') {
            deny(client, 400, 'only http absolute-form requests are supported; use CONNECT for others');
            return;
        }
        const port = url.port ? Number(url.port) : 80;
        const tunnel = await open(route, url.hostname, port);
        if (!tunnel) {
            deny(client, 502, 'could not open a tunnel to the target');
            return;
        }

        const forwarded: string[] = [`${method} ${url.pathname}${url.search} ${version}`];
        for (const [key, value] of Object.entries(headers)) {
            if (!HOP_HEADERS.has(key)) forwarded.push(`${key}: ${value}`);
        }
        // The tunnel carries one request; telling the origin closes it is what lets the read end
        // when the response ends, instead of waiting for a client that has already moved on.
        forwarded.push('connection: close');
        tunnel.write(`${forwarded.join('\r\n')}\r\n\r\n`);
        if (early.length > 0) tunnel.write(early);
        bridge(client, tunnel);
    }

    async function open(route: ProxyRoute, host: string, port: number): Promise<Duplex | null> {
        const label = route.label ?? 'session';
        const routeName = route.viaRelay ? 'relay' : 'direct';
        try {
            const tunnel = await openTunnel(route, host, port, options.relay);
            logger.debug(`[proxy] ${label} ${routeName} ${host}:${port} open`);
            return tunnel;
        } catch (error) {
            // The SOCKS5 URL itself is never part of this message; only the code the hop gave.
            logger.debug(`[proxy] ${label} ${routeName} ${host}:${port} failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
}

/**
 * Extracts the token from a `Proxy-Authorization: Basic …` header.
 *
 * The agent-facing URL is `http://<token>@127.0.0.1:<port>`, so the token is the username and the
 * password is empty. A client that encodes only the token before the colon, or sends the raw
 * value, is accepted too: the token is a credential, not a shape.
 */
function proxyToken(header: string | undefined): string | null {
    if (!header) return null;
    const match = header.match(/^Basic\s+(.+)$/i);
    if (!match) return null;
    let decoded: string;
    try {
        decoded = Buffer.from(match[1].trim(), 'base64').toString('utf8');
    } catch {
        return null;
    }
    const token = decoded.split(':')[0].trim();
    return token.length > 0 ? token : null;
}

function splitAuthority(authority: string): { host: string; port: number } | null {
    const trimmed = authority.trim();
    const lastColon = trimmed.lastIndexOf(':');
    if (lastColon <= 0) return null;
    let host = trimmed.slice(0, lastColon);
    const port = Number(trimmed.slice(lastColon + 1));
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
}

/** Joins the two sockets until both halves are done. */
function bridge(client: Socket, tunnel: Duplex): void {
    client.pipe(tunnel);
    tunnel.pipe(client);
    client.on('error', () => tunnel.destroy());
    tunnel.on('error', () => client.destroy());
    client.on('close', () => tunnel.destroy());
    tunnel.on('close', () => client.destroy());
}

function deny(client: Socket, status: number, message: string): void {
    const body = `${message}\n`;
    client.end(
        `HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}\r\n`
        + 'content-type: text/plain; charset=utf-8\r\n'
        + `content-length: ${Buffer.byteLength(body)}\r\n`
        + 'connection: close\r\n\r\n'
        + body,
    );
}
