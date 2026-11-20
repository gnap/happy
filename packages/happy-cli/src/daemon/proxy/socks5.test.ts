import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseSocks5Url, socks5Connect } from './socks5';
import { startFakeSocksServer } from './fakeSocksServer.testUtil';

function readBytes(socket: ReturnType<typeof connect>, expected: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        let buffered: Buffer = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length >= expected) {
                socket.off('data', onData);
                resolve(buffered);
            }
        };
        socket.on('data', onData);
        socket.once('error', reject);
    });
}

describe('parseSocks5Url', () => {
    it('defaults the port and keeps credentials separate from the address', () => {
        const endpoint = parseSocks5Url('socks5h://user:p%40ss@hop.example');
        expect(endpoint).toEqual({
            scheme: 'socks5h',
            host: 'hop.example',
            port: 1080,
            username: 'user',
            password: 'p@ss',
            remoteDns: true,
        });
    });

    it('is null for anything that is not a SOCKS5 URL', () => {
        expect(parseSocks5Url('http://127.0.0.1:8080')).toBeNull();
        expect(parseSocks5Url('not a url')).toBeNull();
    });
});

describe('socks5Connect', () => {
    it('authenticates, sends a name for socks5h, and leaves the payload after the reply', async () => {
        const server = await startFakeSocksServer({
            requireAuth: true,
            tunnel: 'scripted',
            response: 'hello',
        });
        const socket = connect({ host: '127.0.0.1', port: server.port });
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('error', reject);
            });
            const endpoint = parseSocks5Url(`socks5h://user:p%40ss@127.0.0.1:${server.port}`)!;
            await socks5Connect(socket, 'example.test', 443, endpoint);

            const payload = await readBytes(socket, 5);
            expect(payload.toString('utf8')).toBe('hello');
            expect(server.connections[0].atyp).toBe(0x03);
            expect(server.connections[0].host).toBe('example.test');
            expect(server.connections[0].port).toBe(443);
            expect(server.connections[0].auth).toEqual({ username: 'user', password: 'p@ss' });
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it('sends an IPv4 literal as an address', async () => {
        const server = await startFakeSocksServer({ tunnel: 'record' });
        const socket = connect({ host: '127.0.0.1', port: server.port });
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('error', reject);
            });
            const endpoint = parseSocks5Url(`socks5://127.0.0.1:${server.port}`)!;
            await socks5Connect(socket, '10.1.2.3', 8080, endpoint);

            expect(server.connections[0].atyp).toBe(0x01);
            expect(server.connections[0].host).toBe('10.1.2.3');
            expect(server.connections[0].port).toBe(8080);
        } finally {
            socket.destroy();
            await server.close();
        }
    });

    it('surfaces the reason the proxy gave instead of opening a dead tunnel', async () => {
        const server = await startFakeSocksServer({ reply: 0x05 });
        const socket = connect({ host: '127.0.0.1', port: server.port });
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('error', reject);
            });
            const endpoint = parseSocks5Url(`socks5h://127.0.0.1:${server.port}`)!;
            await expect(socks5Connect(socket, 'example.test', 443, endpoint))
                .rejects.toThrow(/connection refused/);
        } finally {
            socket.destroy();
            await server.close();
        }
    });
});
