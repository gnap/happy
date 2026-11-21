import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectPeerSocket, writePeerMessage } from './peerSocket';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
    for (const socket of sockets.splice(0)) {
        socket.destroy();
    }
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function socketPathFor(name: string): string {
    return join(mkdtempSync(join(tmpdir(), 'happy-peer-')), `${name}.sock`);
}

describe('selectPeerSocket', () => {
    it('picks a socket that belongs to the session process tree', () => {
        const socketPath = socketPathFor('live');
        writeFileSync(socketPath, '', { mode: 0o600 });

        expect(selectPeerSocket([
            { pid: 1, messagingSocketPath: '/tmp/someone-else.sock', startedAt: 10 },
            { pid: 42, messagingSocketPath: socketPath, startedAt: 20 },
        ], new Set([42]))).toBe(socketPath);
    });

    it('prefers the newest registry entry when a restart left two', () => {
        const older = socketPathFor('older');
        const newer = socketPathFor('newer');
        writeFileSync(older, '', { mode: 0o600 });
        writeFileSync(newer, '', { mode: 0o600 });

        expect(selectPeerSocket([
            { pid: 42, messagingSocketPath: older, startedAt: 10 },
            { pid: 43, messagingSocketPath: newer, startedAt: 20 },
        ], new Set([42, 43]))).toBe(newer);
    });

    it('ignores an entry whose socket is gone, which is what an exit looks like', () => {
        expect(selectPeerSocket([
            { pid: 42, messagingSocketPath: '/tmp/happy-peer-no-such-socket.sock', startedAt: 20 },
        ], new Set([42]))).toBeNull();
    });

    it('ignores an entry with no socket, such as a session with messaging off', () => {
        expect(selectPeerSocket([{ pid: 42, startedAt: 20 }], new Set([42]))).toBeNull();
    });
});

describe('writePeerMessage', () => {
    it('writes one user frame and reports delivery', async () => {
        const socketPath = socketPathFor('inbox');
        const received = new Promise<string>((resolve) => {
            const server = createServer((socket) => {
                sockets.push(socket);
                let data = '';
                socket.on('data', (chunk) => {
                    data += chunk.toString('utf8');
                    const newline = data.indexOf('\n');
                    if (newline >= 0) {
                        resolve(data.slice(0, newline));
                        server.close();
                    }
                });
            });
            servers.push(server);
            server.listen(socketPath);
        });

        const delivered = await writePeerMessage(socketPath, 'hello from the daemon');

        expect(delivered).toBe(true);
        expect(JSON.parse(await received)).toMatchObject({
            type: 'user',
            from: 'uds:happy-cli',
            message: { role: 'user', content: 'hello from the daemon' },
        });
    });

    it('reports failure instead of throwing when nothing is listening', async () => {
        expect(await writePeerMessage(socketPathFor('missing'), 'hello')).toBe(false);
    });
});
