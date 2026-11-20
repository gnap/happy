/**
 * A minimal SOCKS5 server for tests: enough of RFC 1928/1929 to accept a CONNECT and then hand
 * bytes to the test.
 *
 * The alternatives are worse. A real proxy would make these tests depend on a network and a
 * credential; a mocked function would skip the handshake framing, which is the part most likely to
 * be wrong. This speaks the protocol over a real socket and nothing else.
 */
import { createServer, type Server, type Socket } from 'node:net';

export type FakeSocksConnection = {
    atyp?: number;
    host?: string;
    port?: number;
    auth?: { username: string; password: string };
    /** Everything the client wrote after the handshake: the proxied request, verbatim. */
    getRequestBytes: () => Buffer;
    writeTunnel: (bytes: string | Buffer) => void;
    closeTunnel: () => void;
};

export type FakeSocksServer = {
    port: number;
    connections: FakeSocksConnection[];
    close: () => Promise<void>;
};

export function startFakeSocksServer(options?: {
    requireAuth?: boolean;
    authOk?: boolean;
    /** The SOCKS5 reply code; 0 means the tunnel opened. */
    reply?: number;
    /** `echo` sends tunneled bytes back; `scripted` answers with `response` and then records. */
    tunnel?: 'echo' | 'record' | 'scripted';
    response?: string;
}): Promise<FakeSocksServer> {
    const connections: FakeSocksConnection[] = [];
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => { /* the test closes these */ });

        let buffer: Buffer = Buffer.alloc(0);
        let stage: 'greeting' | 'auth' | 'request' | 'tunnel' = 'greeting';
        let recorded = Buffer.alloc(0);

        const record = (chunk: Buffer): void => {
            recorded = Buffer.concat([recorded, chunk]);
            if (options?.tunnel === 'echo') socket.write(chunk);
        };

        const connection: FakeSocksConnection = {
            getRequestBytes: () => recorded,
            writeTunnel: (bytes) => socket.write(bytes),
            closeTunnel: () => socket.end(),
        };
        connections.push(connection);

        socket.on('data', (incoming: Buffer | string) => {
            const chunk = typeof incoming === 'string' ? Buffer.from(incoming, 'latin1') : incoming;
            if (stage === 'tunnel') {
                record(chunk);
                return;
            }
            buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
            // Parse only complete messages and consume them when they are complete, so a message
            // split across reads is simply retried and nothing is dropped on the way.
            for (;;) {
                if (stage === 'greeting') {
                    if (buffer.length < 2) return;
                    if (buffer[0] !== 0x05) { socket.destroy(); return; }
                    const count = buffer[1];
                    if (buffer.length < 2 + count) return;
                    const methods = buffer.subarray(2, 2 + count);
                    buffer = buffer.subarray(2 + count);
                    const useAuth = options?.requireAuth === true;
                    if (useAuth && !methods.includes(0x02)) {
                        socket.write(Buffer.from([0x05, 0xff]));
                        return;
                    }
                    socket.write(Buffer.from([0x05, useAuth ? 0x02 : 0x00]));
                    stage = useAuth ? 'auth' : 'request';
                    continue;
                }

                if (stage === 'auth') {
                    if (buffer.length < 2) return;
                    const userLength = buffer[1];
                    if (buffer.length < 2 + userLength + 1) return;
                    const passwordLength = buffer[2 + userLength];
                    const total = 2 + userLength + 1 + passwordLength;
                    if (buffer.length < total) return;
                    connection.auth = {
                        username: buffer.subarray(2, 2 + userLength).toString('utf8'),
                        password: buffer.subarray(3 + userLength, total).toString('utf8'),
                    };
                    buffer = buffer.subarray(total);
                    const ok = options?.authOk !== false;
                    socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
                    if (!ok) return;
                    stage = 'request';
                    continue;
                }

                if (stage === 'request') {
                    if (buffer.length < 4) return;
                    const atyp = buffer[3];
                    const addressLength = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buffer[4] : 0;
                    if (addressLength === 0) { socket.destroy(); return; }
                    const total = 4 + addressLength + 2;
                    if (buffer.length < total) return;
                    connection.atyp = atyp;
                    connection.host = atyp === 0x03
                        ? buffer.subarray(5, 4 + addressLength).toString('utf8')
                        : atyp === 0x01
                            ? [...buffer.subarray(4, 8)].join('.')
                            : [...buffer.subarray(4, 20)].map((byte) => byte.toString(16).padStart(2, '0')).join(':');
                    connection.port = (buffer[total - 2] << 8) | buffer[total - 1];
                    buffer = buffer.subarray(total);
                    const reply = options?.reply ?? 0;
                    socket.write(Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    if (reply !== 0) return;
                    stage = 'tunnel';
                    if (options?.tunnel === 'scripted' && options.response !== undefined) {
                        socket.write(options.response);
                    }
                    // Bytes the client sent in the same packet as the CONNECT are tunnel data.
                    if (buffer.length > 0) {
                        const early = buffer;
                        buffer = Buffer.alloc(0);
                        record(early);
                    }
                    continue;
                }

                return;
            }
        });
    });

    return new Promise<FakeSocksServer>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve({
                port: (server.address() as { port: number }).port,
                connections,
                close: () => new Promise<void>((done) => {
                    for (const socket of sockets) socket.destroy();
                    sockets.clear();
                    server.close(() => done());
                }),
            });
        });
    });
}
