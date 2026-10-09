import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('unix socket server: two processes claiming one session id', () => {
  let home: string;
  let stop: (() => Promise<void>) | undefined;
  const clients: Socket[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'happy-usock-'));
    process.env.HAPPY_HOME_DIR = home;
    vi.resetModules();
  });

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.destroy());
    await stop?.();
    rmSync(home, { recursive: true, force: true });
    delete process.env.HAPPY_HOME_DIR;
  });

  async function start() {
    const { startUnixSocketServer } = await import('./unixSocketServer');
    const server = startUnixSocketServer({
      onSessionHello: () => {},
      onSessionDisconnect: () => {},
      onSessionEvent: () => {},
      onLanDelivery: () => {},
    });
    stop = server.stop;
    await wait(50);
    return server;
  }

  async function connectSession(socketPath: string, sessionId: string, pid: number): Promise<Socket> {
    const client = createConnection(socketPath);
    clients.push(client);
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    client.write(`${JSON.stringify({ type: 'hello', sessionId, sessionTag: 't', pid })}\n`);
    await wait(30);
    return client;
  }

  it('keeps reaching the older live process after the newer claimant disconnects', async () => {
    const server = await start();
    const live = await connectSession(server.socketPath, 'sess-1', 100);
    const received: string[] = [];
    live.on('data', (chunk) => received.push(chunk.toString()));

    const latecomer = await connectSession(server.socketPath, 'sess-1', 200);
    latecomer.destroy();
    await wait(50);

    expect(server.isSessionConnected('sess-1')).toBe(true);
    expect(server.sendToSession('sess-1', { type: 'deliver' })).toBe(true);
    await wait(30);
    expect(received.join('')).toContain('"deliver"');
  });

  it('reports the session gone once every claimant has disconnected', async () => {
    const server = await start();
    const first = await connectSession(server.socketPath, 'sess-2', 100);
    const second = await connectSession(server.socketPath, 'sess-2', 200);
    first.destroy();
    second.destroy();
    await wait(50);

    expect(server.isSessionConnected('sess-2')).toBe(false);
    expect(server.sendToSession('sess-2', { type: 'deliver' })).toBe(false);
  });
});
