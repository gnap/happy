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

    /**
     * The hub: one connection for the whole App, addressing any machine on it.
     *
     * This is what the App uses so that it does not hold a socket per machine, probe each one to
     * find out whether it is up, or derive an address per machine — the relay knows which daemons
     * are dialled in and what sessions they published, so it can answer for all of them at once.
     */
    async function connectHub(port: number) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
        const frames: any[] = [];
        ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
        await until(() => frames.some((f) => f.t === 'ok'));
        const send = (frame: unknown) => ws.send(JSON.stringify(frame));
        return { ws, frames, send, reply: (t: string, id?: number) => frames.filter((f) => f.t === t && (id === undefined || f.id === id)) };
    }

    it('carries streams to several machines over one client connection', async () => {
        relay = startRelay({ port: 0 });
        const a = await connectDaemon(relay.port);
        const b = await connectDaemon(relay.port);
        await until(() => a.frames.some((f) => f.t === 'ok') && b.frames.some((f) => f.t === 'ok'));
        // Each daemon answers whatever is opened on it, tagged with its own name.
        for (const [d, name] of [[a, 'a'], [b, 'b']] as const) {
            d.ws.addEventListener('message', (e) => {
                const msg = JSON.parse(String(e.data));
                if (msg.t === 'ws-open') d.ws.send(JSON.stringify({ t: 'ws-msg', id: msg.id, data: `${name}:${msg.path}` }));
                if (msg.t === 'ws-msg') d.ws.send(JSON.stringify({ t: 'ws-msg', id: msg.id, data: `echo:${msg.data}` }));
            });
        }

        const hub = await connectHub(relay.port);
        hub.send({ t: 'open', id: 10, tag: a.tag, path: '/lan/socket?x=1' });
        hub.send({ t: 'open', id: 11, tag: b.tag, path: '/lan/socket?x=2' });
        await until(() => hub.reply('msg').length === 2);
        expect(hub.reply('msg').map((f) => f.data).sort()).toEqual(['a:/lan/socket?x=1', 'b:/lan/socket?x=2']);

        // A frame sent on one stream reaches only that stream's daemon.
        hub.send({ t: 'msg', id: 11, data: 'only-b' });
        await until(() => hub.reply('msg', 11).length === 2);
        expect(hub.reply('msg', 11).map((f) => f.data)).toEqual(['b:/lan/socket?x=2', 'echo:only-b']);
        expect(hub.reply('msg', 10).length).toBe(1);
    });

    it('tells a client a stream ended, rather than leaving it waiting', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        const hub = await connectHub(relay.port);
        hub.send({ t: 'open', id: 1, tag: d.tag, path: '/lan/socket' });
        await until(() => d.frames.some((f) => f.t === 'ws-open'));

        // The daemon side closes it (its own reader went away).
        const opened = d.frames.find((f) => f.t === 'ws-open');
        d.ws.send(JSON.stringify({ t: 'ws-close', id: opened.id, code: 1000, reason: 'bye' }));
        await until(() => hub.reply('close').length === 1);
        expect(hub.reply('close')[0]).toMatchObject({ id: 1, code: 1000, reason: 'bye' });
    });

    it('closes a machine\'s streams when that machine goes offline', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        const hub = await connectHub(relay.port);
        hub.send({ t: 'open', id: 7, tag: d.tag, path: '/lan/socket' });
        await until(() => d.frames.some((f) => f.t === 'ws-open'));

        d.ws.close();
        await until(() => hub.reply('close', 7).length === 1);
        expect(hub.reply('close', 7)[0]).toMatchObject({ code: 4502 });
    });

    it('answers for every machine and the sessions they published', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        const sessions = [{ happySessionId: 's1', directory: '/work', agent: 'claude', startedBy: 'daemon', isAlive: true }];
        d.ws.send(JSON.stringify({ t: 'sessions', sessions }));

        const hub = await connectHub(relay.port);
        hub.send({ t: 'machines' });
        await until(() => hub.reply('machines').some((f) => f.machines.length === 1));
        const answer = hub.reply('machines').find((f) => f.machines.length === 1);
        expect(answer.machines[0]).toEqual({ tag: d.tag, sessions });

        // A machine dialling in is pushed to the client: it is the event the App waits for, and
        // asking for it on a timer is the probing this connection replaces.
        const before = hub.reply('machines').length;
        const second = await connectDaemon(relay.port);
        await until(() => second.frames.some((f) => f.t === 'ok'));
        await until(() => hub.frames.filter((f) => f.t === 'machines').length > before);
        const latest = hub.frames.filter((f) => f.t === 'machines').at(-1);
        expect(latest.machines.map((m: { tag: string }) => m.tag)).toContain(second.tag);
    });

    it('proxies an http request to the machine the client names', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        d.ws.addEventListener('message', (e) => {
            const msg = JSON.parse(String(e.data));
            if (msg.t === 'http') {
                d.ws.send(JSON.stringify({
                    t: 'http-res', id: msg.id, status: 200, headers: { 'content-type': 'application/json' },
                    body: Buffer.from(JSON.stringify({ path: msg.path })).toString('base64'),
                }));
            }
        });
        const hub = await connectHub(relay.port);
        hub.send({ t: 'http', id: 3, tag: d.tag, method: 'GET', path: '/lan/sessions' });
        await until(() => hub.reply('http-res', 3).length === 1);
        expect(hub.reply('http-res', 3)[0]).toMatchObject({ status: 200 });
        expect(JSON.parse(Buffer.from(hub.reply('http-res', 3)[0].body, 'base64').toString())).toEqual({ path: '/lan/sessions' });
    });

    it('says a machine is offline instead of hanging the stream', async () => {
        relay = startRelay({ port: 0 });
        const hub = await connectHub(relay.port);
        hub.send({ t: 'open', id: 5, tag: 'c'.repeat(32), path: '/lan/socket' });
        await until(() => hub.reply('close', 5).length === 1);
        expect(hub.reply('close', 5)[0]).toMatchObject({ code: 4502, reason: 'offline' });
    });
});
