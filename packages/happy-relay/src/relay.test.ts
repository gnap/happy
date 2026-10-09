import { describe, expect, it, afterEach } from 'bun:test';
import nacl from 'tweetnacl';
import { startRelay, tagOfPublicKey, REGISTER_CONTEXT, type RelayHandle } from './relay';

let relay: RelayHandle | null = null;
afterEach(() => { relay?.stop(); relay = null; });

async function connectDaemon(port: number, pair = nacl.sign.keyPair(), sign = true) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
    const frames: any[] = [];
    const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
    ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.t === 'challenge') {
            const sig = sign
                ? nacl.sign.detached(Buffer.from(REGISTER_CONTEXT + msg.nonce), pair.secretKey)
                : new Uint8Array(64);
            ws.send(JSON.stringify({ t: 'register', pub: Buffer.from(pair.publicKey).toString('base64'), sig: Buffer.from(sig).toString('base64') }));
        }
        frames.push(msg);
    };
    return { ws, frames, closed, tag: tagOfPublicKey(pair.publicKey) };
}
const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(20); };

describe('relay', () => {
    it('returns offline quickly when no daemon is registered', async () => {
        relay = startRelay({ port: 0 });
        const res = await fetch(`http://127.0.0.1:${relay.port}/r/${'a'.repeat(32)}/lan/identity`);
        expect(res.status).toBe(502);
    });

    it('rejects a forged signature and does not register the tag', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port, undefined, false);
        expect(await d.closed).toBe(4401);
        expect(relay.daemonCount()).toBe(0);
    });

    it('forwards http through the daemon and echoes the body', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        d.ws.addEventListener('message', (e) => {
            const msg = JSON.parse(String(e.data));
            if (msg.t === 'http') {
                d.ws.send(JSON.stringify({
                    t: 'http-res', id: msg.id, status: 201, headers: { 'content-type': 'text/plain' },
                    body: Buffer.from(`${msg.method} ${msg.path} ${Buffer.from(msg.body, 'base64')}`).toString('base64'),
                }));
            }
        });
        const res = await fetch(`http://127.0.0.1:${relay.port}/r/${d.tag}/lan/session?x=1`, { method: 'POST', body: 'hello' });
        expect(res.status).toBe(201);
        expect(await res.text()).toBe('POST /lan/session?x=1 hello');
    });

    it('bridges websocket frames both ways and propagates close', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        d.ws.addEventListener('message', (e) => {
            const msg = JSON.parse(String(e.data));
            if (msg.t === 'ws-open') d.ws.send(JSON.stringify({ t: 'ws-msg', id: msg.id, data: 'hi' }));
            if (msg.t === 'ws-msg') d.ws.send(JSON.stringify({ t: 'ws-msg', id: msg.id, data: 'echo:' + msg.data }));
        });
        const client = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${d.tag}/lan/socket?n=1`);
        const got: string[] = [];
        client.onmessage = (e) => got.push(String(e.data));
        await until(() => got.length === 1);
        client.send('ping');
        await until(() => got.length === 2);
        expect(got).toEqual(['hi', 'echo:ping']);
        client.close();
        await until(() => d.frames.some((f) => f.t === 'ws-close'));
        expect(d.frames.some((f) => f.t === 'ws-close')).toBe(true);
    });

    it('fails pending requests when the daemon drops', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        d.ws.addEventListener('message', (e) => { if (JSON.parse(String(e.data)).t === 'http') d.ws.close(); });
        const res = await fetch(`http://127.0.0.1:${relay.port}/r/${d.tag}/lan/identity`);
        expect(res.status).toBe(502);
    });

    it('rate limits per ip', async () => {
        relay = startRelay({ port: 0, ratePerMinute: 3 });
        const url = `http://127.0.0.1:${relay.port}/r/${'b'.repeat(32)}/x`;
        const codes: number[] = [];
        for (let i = 0; i < 5; i++) codes.push((await fetch(url)).status);
        expect(codes).toEqual([502, 502, 502, 429, 429]);
    });
});
