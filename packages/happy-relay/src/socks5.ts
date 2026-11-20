/**
 * A SOCKS5 client, used only when a route names a hop.
 *
 * A route's definition lives on this relay, so this relay — not the machine — holds the hop's
 * address and credentials and performs the handshake. The daemon names a route and a target; what
 * sits behind the route never reaches a machine.
 *
 * Deliberately just the protocol: it does not dial, and it does not know what carries the bytes.
 * The same code therefore works over a TCP socket here and over a relay pipe in the CLI.
 *
 * `socks5h` sends the target name to the proxy, which resolves it (`ATYP=domain`), and is the
 * common case here because the proxy is the only party that can resolve names where it lives.
 * `socks5` resolves locally first, as that scheme promises, falling back to letting the proxy
 * resolve when the local resolver has no IPv4 answer.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';

export type Socks5Endpoint = {
    scheme: 'socks5' | 'socks5h';
    host: string;
    port: number;
    username?: string;
    password?: string;
    /** Ask the proxy to resolve the target name rather than doing it here. */
    remoteDns: boolean;
};

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Parses `socks5://` and `socks5h://` URLs, with or without credentials.
 *
 * Returns null rather than throwing: this runs on the relay's own routes file, and one malformed
 * line must turn into a refused route, not a relay that cannot start.
 */
export function parseSocks5Url(raw: string): Socks5Endpoint | null {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    const scheme = url.protocol === 'socks5h:' ? 'socks5h' : url.protocol === 'socks5:' ? 'socks5' : null;
    if (!scheme) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) return null;
    const port = url.port ? Number(url.port) : 1080;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    let username: string | undefined;
    let password: string | undefined;
    try {
        if (url.username) username = decodeURIComponent(url.username);
        if (url.password) password = decodeURIComponent(url.password);
    } catch {
        return null;
    }
    // RFC 1929 length-prefixes each field with one byte.
    if ((username?.length ?? 0) > 255 || (password?.length ?? 0) > 255) return null;
    return { scheme, host, port, username, password, remoteDns: scheme === 'socks5h' };
}

/**
 * Performs the handshake and the CONNECT request, leaving `socket` positioned at the first byte
 * of the target's data.
 */
export async function socks5Connect(
    socket: Duplex,
    targetHost: string,
    targetPort: number,
    endpoint: Socks5Endpoint,
): Promise<void> {
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        throw new Error('SOCKS5: invalid target port');
    }
    const timer = setTimeout(() => socket.destroy(new Error('SOCKS5: handshake timed out')), HANDSHAKE_TIMEOUT_MS);
    try {
        // Offer no-auth always, and username/password when the URL has one. Accepting whatever the
        // proxy picks is what makes one URL work with a proxy that requires auth and one that does
        // not, without the caller having to know which it is.
        const methods = endpoint.username !== undefined ? [0x00, 0x02] : [0x00];
        socket.write(Buffer.from([0x05, methods.length, ...methods]));
        const greeting = await readExactly(socket, 2);
        if (greeting[0] !== 0x05) throw new Error('SOCKS5: proxy did not answer with SOCKS5');
        if (greeting[1] === 0xff) {
            throw new Error(endpoint.username !== undefined
                ? 'SOCKS5: proxy rejected every offered auth method'
                : 'SOCKS5: proxy requires authentication');
        }
        if (greeting[1] === 0x02) {
            if (endpoint.username === undefined) throw new Error('SOCKS5: proxy requires username/password');
            const user = Buffer.from(endpoint.username, 'utf8');
            const pass = Buffer.from(endpoint.password ?? '', 'utf8');
            socket.write(Buffer.concat([
                Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass,
            ]));
            const auth = await readExactly(socket, 2);
            if (auth[0] !== 0x01 || auth[1] !== 0x00) throw new Error('SOCKS5: authentication rejected');
        } else if (greeting[1] !== 0x00) {
            throw new Error(`SOCKS5: proxy chose an unsupported auth method (${greeting[1]})`);
        }

        const address = await targetAddress(targetHost, endpoint.remoteDns);
        const port = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, port]));

        const head = await readExactly(socket, 4);
        if (head[0] !== 0x05) throw new Error('SOCKS5: malformed reply');
        if (head[1] !== 0x00) throw new Error(`SOCKS5: ${replyMessage(head[1])}`);
        // The reply carries the bound address and port. Drain them, or the target's first bytes
        // would be read as part of the address.
        if (head[3] === 0x01) {
            await readExactly(socket, 4 + 2);
        } else if (head[3] === 0x04) {
            await readExactly(socket, 16 + 2);
        } else if (head[3] === 0x03) {
            const length = (await readExactly(socket, 1))[0];
            await readExactly(socket, length + 2);
        } else {
            throw new Error('SOCKS5: unknown address type in reply');
        }
    } finally {
        clearTimeout(timer);
    }
}

async function targetAddress(host: string, remoteDns: boolean): Promise<Buffer> {
    const kind = isIP(host);
    if (kind === 4) {
        return Buffer.from([0x01, ...host.split('.').map((part) => Number(part))]);
    }
    if (remoteDns || kind === 6) {
        // An IPv6 literal is sent as a name: every SOCKS5 proxy resolves its own literal, and
        // the alternative is a second IPv6 parser here for no gain.
        return domainAddress(host);
    }
    try {
        const answer = await lookup(host, { family: 4 });
        return Buffer.from([0x01, ...answer.address.split('.').map((part) => Number(part))]);
    } catch {
        return domainAddress(host);
    }
}

function domainAddress(host: string): Buffer {
    const name = Buffer.from(host, 'utf8');
    if (name.length === 0 || name.length > 255) throw new Error('SOCKS5: invalid target host');
    return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

function replyMessage(code: number): string {
    switch (code) {
        case 0x01: return 'general failure';
        case 0x02: return 'connection not allowed';
        case 0x03: return 'network unreachable';
        case 0x04: return 'host unreachable';
        case 0x05: return 'connection refused';
        case 0x06: return 'ttl expired';
        case 0x07: return 'command not supported';
        case 0x08: return 'address type not supported';
        default: return `request failed (${code})`;
    }
}

/**
 * Reads exactly `n` bytes from a paused stream, leaving anything beyond them buffered.
 *
 * A handshake is a sequence of small fixed-size reads, and the bytes that follow it are the
 * target's — they must not be lost to a `data` listener that happened to be attached too early.
 * `read()` in paused mode plus `unshift()` for the excess is the only way to split them without a
 * second buffering layer.
 */
function readExactly(socket: Duplex, n: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        let buffered: Buffer = Buffer.alloc(0);
        const cleanup = () => {
            socket.off('readable', onReadable);
            socket.off('error', onError);
            socket.off('close', onClose);
        };
        const onReadable = () => {
            let chunk: Buffer | null;
            while ((chunk = socket.read() as Buffer | null) !== null) {
                buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
                if (buffered.length < n) continue;
                cleanup();
                const wanted = buffered.subarray(0, n);
                const rest = buffered.subarray(n);
                if (rest.length > 0) socket.unshift(rest);
                resolve(wanted);
                return;
            }
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onClose = () => { cleanup(); reject(new Error('SOCKS5: connection closed during handshake')); };
        socket.on('readable', onReadable);
        socket.on('error', onError);
        socket.on('close', onClose);
        // Data may already be buffered before the listener was attached.
        onReadable();
    });
}
