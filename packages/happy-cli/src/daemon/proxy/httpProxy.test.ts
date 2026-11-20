import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { RelayClientHandle } from '@/daemon/relay/relayClient';
import { startLocalProxy } from './httpProxy';
import { startFakeSocksServer } from './fakeSocksServer.testUtil';

const TOKEN = 'tok';
const BASIC = Buffer.from(`${TOKEN}:`).toString('base64');

function openClient(port: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

function readUntil(socket: Socket, predicate: (text: string) => boolean, timeoutMs = 3_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`timed out; received: ${text}`));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
        };
        const onData = (chunk: Buffer) => {
            text += chunk.toString('latin1');
            if (predicate(text)) {
                cleanup();
                resolve(text);
            }
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        socket.on('data', onData);
        socket.on('error', onError);
    });
}

describe('local HTTP proxy', () => {
    it('turns a CONNECT into a SOCKS5 tunnel and passes the early bytes through it', async () => {
        const socks = await startFakeSocksServer({ requireAuth: true, tunnel: 'echo' });
        const proxy = await startLocalProxy({
            getRoute: (token) => token === TOKEN
                ? { socks5: `socks5h://user:pass@127.0.0.1:${socks.port}`, viaRelay: false }
                : null,
            relay: () => null,
        });
        const client = await openClient(proxy.port);
        try {
            client.write(
                `CONNECT example.test:443 HTTP/1.1\r\n`
                + 'Host: example.test:443\r\n'
                + `Proxy-Authorization: Basic ${BASIC}\r\n\r\n`
                + 'ping',
            );
            const response = await readUntil(client, (text) => text.includes('ping'));
            expect(response.startsWith('HTTP/1.1 200 Connection Established\r\n\r\n')).toBe(true);
            expect(socks.connections[0].host).toBe('example.test');
            expect(socks.connections[0].port).toBe(443);
            expect(socks.connections[0].auth).toEqual({ username: 'user', password: 'pass' });
        } finally {
            client.destroy();
            await proxy.stop();
            await socks.close();
        }
    });

    it('rewrites an absolute-form request to origin-form and drops hop headers', async () => {
        const socks = await startFakeSocksServer({
            tunnel: 'scripted',
            response: 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok',
        });
        const proxy = await startLocalProxy({
            getRoute: (token) => token === TOKEN
                ? { socks5: `socks5h://127.0.0.1:${socks.port}`, viaRelay: false }
                : null,
            relay: () => null,
        });
        const client = await openClient(proxy.port);
        try {
            client.write(
                'GET http://example.test/things?q=1 HTTP/1.1\r\n'
                + 'Host: example.test\r\n'
                + `Proxy-Authorization: Basic ${BASIC}\r\n`
                + 'Proxy-Connection: keep-alive\r\n'
                + 'X-Test: 1\r\n\r\n',
            );
            const response = await readUntil(client, (text) => text.includes('ok'));
            expect(response).toContain('HTTP/1.1 200 OK');
            const forwarded = socks.connections[0].getRequestBytes().toString('latin1');
            expect(forwarded.startsWith('GET /things?q=1 HTTP/1.1\r\n')).toBe(true);
            expect(forwarded.toLowerCase()).not.toContain('proxy-authorization');
            expect(forwarded.toLowerCase()).not.toContain('proxy-connection');
            expect(forwarded.toLowerCase()).toContain('x-test: 1');
            expect(forwarded.toLowerCase()).toContain('connection: close');
        } finally {
            client.destroy();
            await proxy.stop();
            await socks.close();
        }
    });

    it('refuses a request whose token has no route rather than choosing one by default', async () => {
        const proxy = await startLocalProxy({ getRoute: () => null, relay: () => null });
        const client = await openClient(proxy.port);
        try {
            client.write(
                'CONNECT example.test:443 HTTP/1.1\r\n'
                + `Proxy-Authorization: Basic ${Buffer.from('other:').toString('base64')}\r\n\r\n`,
            );
            const response = await readUntil(client, (text) => text.includes('\r\n\r\n'));
            expect(response).toContain('HTTP/1.1 502');
        } finally {
            client.destroy();
            await proxy.stop();
        }
    });

    it('uses the relay when the route says so, and never dials the hop itself', async () => {
        const socks = await startFakeSocksServer({ tunnel: 'echo' });
        let relayRequests = 0;
        const relay = {
            openEgress: async (host: string, port: number) => {
                relayRequests++;
                expect(host).toBe('127.0.0.1');
                expect(port).toBe(socks.port);
                const socket = connect({ host: '127.0.0.1', port: socks.port });
                await new Promise<void>((resolve, reject) => {
                    socket.once('connect', resolve);
                    socket.once('error', reject);
                });
                return socket;
            },
        } as unknown as RelayClientHandle;
        const proxy = await startLocalProxy({
            getRoute: (token) => token === TOKEN
                ? { socks5: `socks5h://127.0.0.1:${socks.port}`, viaRelay: true }
                : null,
            relay: () => relay,
        });
        const client = await openClient(proxy.port);
        try {
            client.write(
                'CONNECT example.test:443 HTTP/1.1\r\n'
                + `Proxy-Authorization: Basic ${BASIC}\r\n\r\n`
                + 'ping',
            );
            const response = await readUntil(client, (text) => text.includes('ping'));
            expect(response.startsWith('HTTP/1.1 200')).toBe(true);
            expect(relayRequests).toBe(1);
            expect(socks.connections[0].host).toBe('example.test');
        } finally {
            client.destroy();
            await proxy.stop();
            await socks.close();
        }
    });

    it('lets the relay dial the target when the route names no hop', async () => {
        // The relay's far side, standing in for the origin: whatever the daemon sends comes back.
        const origin = createServer((socket) => socket.pipe(socket));
        await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
        const originPort = (origin.address() as AddressInfo).port;
        const requested: Array<{ host: string; port: number }> = [];
        const relay = {
            openEgress: async (host: string, port: number) => {
                requested.push({ host, port });
                const socket = connect({ host: '127.0.0.1', port: originPort });
                await new Promise<void>((resolve, reject) => {
                    socket.once('connect', resolve);
                    socket.once('error', reject);
                });
                return socket;
            },
        } as unknown as RelayClientHandle;
        const proxy = await startLocalProxy({
            getRoute: (token) => token === TOKEN ? { viaRelay: true } : null,
            relay: () => relay,
        });
        const client = await openClient(proxy.port);
        try {
            client.write(
                'CONNECT origin.test:443 HTTP/1.1\r\n'
                + `Proxy-Authorization: Basic ${BASIC}\r\n\r\n`
                + 'ping',
            );
            const response = await readUntil(client, (text) => text.includes('ping'));
            expect(response.startsWith('HTTP/1.1 200')).toBe(true);
            expect(requested).toEqual([{ host: 'origin.test', port: 443 }]);
        } finally {
            client.destroy();
            await proxy.stop();
            await new Promise<void>((resolve) => origin.close(() => resolve()));
        }
    });

    it('fails closed when the relay the route needs is not connected', async () => {
        const proxy = await startLocalProxy({
            getRoute: (token) => token === TOKEN
                ? { socks5: 'socks5h://127.0.0.1:9', viaRelay: true }
                : null,
            relay: () => null,
        });
        const client = await openClient(proxy.port);
        try {
            client.write(
                'CONNECT example.test:443 HTTP/1.1\r\n'
                + `Proxy-Authorization: Basic ${BASIC}\r\n\r\n`,
            );
            const response = await readUntil(client, (text) => text.includes('\r\n\r\n'));
            expect(response).toContain('HTTP/1.1 502');
        } finally {
            client.destroy();
            await proxy.stop();
        }
    });
});
