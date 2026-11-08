import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchWithTimeout } from './fetchWithTimeout';

/**
 * These exercise the property the helper exists for: a server that accepts the connection and then
 * simply never answers must produce a *failure*, not a hang. That is the case a `timeout` option
 * does not cover and the one that leaves a sync wedged forever.
 */
async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
}

describe('fetchWithTimeout', () => {
    it('fails a request whose server accepts but never answers', async () => {
        // Deliberately never calls res.end() — the connection stays open and silent.
        const { server, port } = await listen(() => { /* no response, ever */ });
        try {
            const started = Date.now();
            await expect(fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 300)).rejects.toThrow();
            const elapsed = Date.now() - started;
            // Bound held: it gave up near the timeout rather than waiting indefinitely.
            expect(elapsed).toBeLessThan(3000);
        } finally {
            server.close();
        }
    });

    it('returns the response when the server answers in time', async () => {
        const { server, port } = await listen((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('packager-status:running');
        });
        try {
            const response = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 2000);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe('packager-status:running');
        } finally {
            server.close();
        }
    });

    it('honours a caller signal that is already aborted', async () => {
        const { server, port } = await listen((_req, res) => res.end('late'));
        try {
            const controller = new AbortController();
            controller.abort();
            await expect(
                fetchWithTimeout(`http://127.0.0.1:${port}/`, { signal: controller.signal }, 2000)
            ).rejects.toThrow();
        } finally {
            server.close();
        }
    });

    it('does not leave a timer behind on a successful request', async () => {
        // A leaked timer would keep the process alive; vitest reports that as a hang at exit, so
        // this asserts indirectly by simply completing the suite.
        const { server, port } = await listen((_req, res) => res.end('ok'));
        try {
            for (let i = 0; i < 5; i++) {
                await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 2000);
            }
        } finally {
            server.close();
        }
    });
});
