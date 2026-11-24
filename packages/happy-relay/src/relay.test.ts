import { describe, expect, it, afterEach } from 'bun:test';
import nacl from 'tweetnacl';
import { connect as connectTcp, createServer as createTcpServer, type Server as TcpServer, type Socket as TcpSocket } from 'node:net';
import { startRelay, tagOfPublicKey, REGISTER_CONTEXT, type RelayHandle } from './relay';

let relay: RelayHandle | null = null;
afterEach(() => { relay?.stop(); relay = null; });

async function connectDaemon(
    port: number,
    pair = nacl.sign.keyPair(),
    sign = true,
    lane?: { lane: 'egress'; slot: number },
) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
    const frames: any[] = [];
    const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
    ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.t === 'challenge') {
            const sig = sign
                ? nacl.sign.detached(Buffer.from(REGISTER_CONTEXT + msg.nonce), pair.secretKey)
                : new Uint8Array(64);
            ws.send(JSON.stringify({
                t: 'register',
                pub: Buffer.from(pair.publicKey).toString('base64'),
                sig: Buffer.from(sig).toString('base64'),
                ...(lane ?? {}),
            }));
        }
        frames.push(msg);
    };
    return { ws, frames, closed, tag: tagOfPublicKey(pair.publicKey) };
}
const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(20); };

/**
 * A target for the egress tests: it echoes what it is given and remembers its sockets, so a test
 * can tell a pipe the relay opened from one it has since closed.
 */
async function startEchoTarget(): Promise<{ port: number; sockets: Set<TcpSocket>; close: () => Promise<void> }> {
    const sockets = new Set<TcpSocket>();
    const server: TcpServer = createTcpServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => { /* the relay's close is the test's business */ });
        socket.on('data', (chunk) => socket.write(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return {
        port: address.port,
        sockets,
        close: () => new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
        }),
    };
}

/**
 * A SOCKS5 hop for the route tests: no-auth by default, username/password when credentials are
 * given. It remembers the CONNECT requests so a test can tell "the relay reached the target
 * through this hop" from "the relay dialled the target itself".
 */
async function startSocks5Hop(options: { user?: string; pass?: string } = {}): Promise<{
    port: number;
    requests: Array<{ host: string; port: number }>;
    close: () => Promise<void>;
}> {
    const requests: Array<{ host: string; port: number }> = [];
    const sockets = new Set<TcpSocket>();
    const server: TcpServer = createTcpServer((socket) => {
        sockets.add(socket);
        let buffered = Buffer.alloc(0);
        let state: 'greeting' | 'auth' | 'request' | 'pipe' = 'greeting';
        let upstream: TcpSocket | null = null;
        // A hop owns the upstream it opened: when either side goes, the other must not linger,
        // which is also what lets a test see the pipe actually close.
        socket.on('close', () => { sockets.delete(socket); upstream?.destroy(); });
        socket.on('error', () => { /* the test's assertions own the failure */ });
        socket.on('data', (chunk: Buffer) => {
            if (state === 'pipe') { upstream?.write(chunk); return; }
            buffered = Buffer.concat([buffered, chunk]);
            if (state === 'greeting') {
                if (buffered.length < 2) return;
                const count = buffered[1];
                if (buffered.length < 2 + count) return;
                const methods = [...buffered.subarray(2, 2 + count)];
                buffered = buffered.subarray(2 + count);
                if (options.user) {
                    if (!methods.includes(0x02)) { socket.end(Buffer.from([0x05, 0xff])); return; }
                    socket.write(Buffer.from([0x05, 0x02]));
                    state = 'auth';
                } else {
                    socket.write(Buffer.from([0x05, 0x00]));
                    state = 'request';
                }
            }
            if (state === 'auth') {
                if (buffered.length < 3) return;
                const userLength = buffered[1];
                if (buffered.length < 2 + userLength + 1) return;
                const passLength = buffered[2 + userLength];
                if (buffered.length < 3 + userLength + passLength) return;
                const user = buffered.subarray(2, 2 + userLength).toString();
                const pass = buffered.subarray(3 + userLength, 3 + userLength + passLength).toString();
                buffered = buffered.subarray(3 + userLength + passLength);
                if (user !== options.user || pass !== options.pass) { socket.end(Buffer.from([0x01, 0x01])); return; }
                socket.write(Buffer.from([0x01, 0x00]));
                state = 'request';
            }
            if (state === 'request') {
                if (buffered.length < 5) return;
                const atyp = buffered[3];
                let host: string;
                let offset: number;
                if (atyp === 0x01) {
                    if (buffered.length < 10) return;
                    host = [...buffered.subarray(4, 8)].join('.');
                    offset = 8;
                } else if (atyp === 0x03) {
                    const length = buffered[4];
                    if (buffered.length < 7 + length) return;
                    host = buffered.subarray(5, 5 + length).toString();
                    offset = 5 + length;
                } else {
                    socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    return;
                }
                const port = buffered.readUInt16BE(offset);
                const early = buffered.subarray(offset + 2);
                buffered = Buffer.alloc(0);
                requests.push({ host, port });
                upstream = connectTcp({ host, port });
                upstream.on('error', () => socket.destroy());
                upstream.on('connect', () => {
                    socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    if (early.length > 0) upstream!.write(early);
                    state = 'pipe';
                    upstream!.on('data', (data) => socket.write(data));
                });
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return {
        port: address.port,
        requests,
        close: () => new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
        }),
    };
}

describe('relay', () => {
    /**
     * The preflight has to be answered wherever it is asked, because that is where a browser asks
     * it: before the request, for whatever URL the client is about to use. Answering only the paths
     * that happen to exist turns every other URL into a network failure in the browser — which is
     * indistinguishable from a relay that is down, and is what a session read did when it went out
     * over a route the relay did not recognise.
     */
    it('answers a preflight for a path it does not serve, and for a tag it does not know', async () => {
        relay = startRelay({ port: 0 });
        for (const path of ['/lan/challenge', `/r/${'a'.repeat(32)}/anything`, '/r/not-a-tag/lan/identity']) {
            const res = await fetch(`http://127.0.0.1:${relay.port}${path}`, {
                method: 'OPTIONS',
                headers: {
                    origin: 'http://localhost:8081',
                    'access-control-request-method': 'GET',
                    'access-control-request-headers': 'authorization',
                },
            });
            expect(res.status, path).toBe(204);
            expect(res.headers.get('access-control-allow-headers'), path).toContain('authorization');
            expect(res.headers.get('access-control-allow-origin'), path).toBe('*');
        }
    });

    it('allows the headers an account proof is sent in', async () => {
        // A control submit through the relay is the same browser POST with the proof headers on it.
        // A preflight the relay answers without them is a refusal the daemon never sees, so the
        // submit reads as a machine that will not answer, and falls to a channel that cannot
        // carry it.
        relay = startRelay({ port: 0 });
        const res = await fetch(`http://127.0.0.1:${relay.port}/r/${'a'.repeat(32)}/lan/sessions/s/control`, {
            method: 'OPTIONS',
            headers: {
                origin: 'http://localhost:8081',
                'access-control-request-method': 'POST',
                'access-control-request-headers':
                    'authorization, content-type, x-happy-proof-nonce, x-happy-proof-at, x-happy-proof-signature',
            },
        });
        expect(res.status).toBe(204);
        for (const header of ['x-happy-proof-nonce', 'x-happy-proof-at', 'x-happy-proof-signature']) {
            expect(res.headers.get('access-control-allow-headers')).toContain(header);
        }
    });

    it('carries the CORS headers on the errors it answers itself', async () => {
        relay = startRelay({ port: 0 });
        const res = await fetch(`http://127.0.0.1:${relay.port}/not-a-route`, { headers: { origin: 'http://localhost:8081' } });
        expect(res.status).toBe(404);
        // Without these a browser cannot read the answer, so a 404 is delivered as a network error.
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    });

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
    async function connectHub(port: number, mode: 'legacy' | 'http' = 'legacy') {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/client${mode === 'http' ? '?dir=http' : ''}`);
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

    it('carries where a machine says it can be reached, without reading it', async () => {
        // The relay stores this blob the way it stores the session summary — it is the machine's own
        // claim about itself, and the shape is the daemon's business. What it buys is the case the
        // relay exists for: the App's server is unreachable, so the LAN address cannot come from
        // there, and the relay is the only party still holding it.
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        const reachable = { endpoints: [{ t: 'lan', addr: '192.168.1.5', port: 55673 }], at: 1700, rev: 4 };
        d.ws.send(JSON.stringify({ t: 'reachable', ...reachable }));

        const hub = await connectHub(relay.port);
        hub.send({ t: 'machines' });
        await until(() => hub.reply('machines').some((f) => f.machines.some((m: any) => m.reachable)));
        const answer = hub.reply('machines').find((f) => f.machines.some((m: any) => m.reachable));
        expect(answer.machines.find((m: any) => m.tag === d.tag).reachable).toEqual(reachable);
    });

    it('answers for every machine, with the session roster narrowed to what a directory is for', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        // What a daemon actually publishes: a whole summary, metadata and agent state included,
        // because the same list serves a LAN reader that opens a session's name from it.
        const sessions = [{
            happySessionId: 's1',
            tag: 't1',
            // The lineage's public name: small like the projection, and what lets a reader keep a
            // conversation's row together when the server issues a different id.
            sessionUid: 'uid-1',
            directory: '/work',
            agent: 'claude',
            startedBy: 'daemon',
            isAlive: true,
            metadataVersion: 3,
            metadata: 'x'.repeat(4096),
            agentStateVersion: 2,
            agentState: 'y'.repeat(4096),
            dataEncryptionKey: 'z'.repeat(1024),
            origin: 'server',
            // The machine's projection is small and is what an App draws a row from, so it rides
            // along instead of being dropped with the blobs.
            phase: 'Running',
            generation: 4,
            observedGeneration: 4,
            observedAt: 1_234,
            reason: 'registered',
            // The want beside the observation: whether the machine is still working on the row,
            // and why it stopped if it did. Same reason as the phase — a directory reader draws
            // a stuck row from it without opening a channel.
            desiredLifecycle: 'running',
            divergence: {
                desired: 'running',
                generation: 5,
                reason: 'want-not-observed',
                since: 1_500,
                attempts: 5,
                blocked: true,
            },
        }];
        d.ws.send(JSON.stringify({ t: 'sessions', sessions }));

        const hub = await connectHub(relay.port);
        hub.send({ t: 'machines' });
        await until(() => hub.reply('machines').some((f) => f.machines.length === 1));
        const answer = hub.reply('machines').find((f) => f.machines.length === 1);
        // `reachable` rides along in the same entry: the address a machine publishes for itself,
        // which is what an App with no server left needs in order to reach it directly.
        //
        // The session rows are the identity and liveness a directory answers — not the encrypted
        // metadata and agent state, which a read pulls over the session's own channel. Keeping
        // those here put a megabyte on every hub client's connection each time any machine's list
        // moved, and a stream's first frame queued behind them is what read as "did not open".
        expect(answer.machines[0]).toEqual({
            tag: d.tag,
            sessions: [{
                happySessionId: 's1',
                tag: 't1',
                sessionUid: 'uid-1',
                isAlive: true,
                origin: 'server',
                phase: 'Running',
                generation: 4,
                observedGeneration: 4,
                observedAt: 1_234,
                reason: 'registered',
                desiredLifecycle: 'running',
                divergence: {
                    desired: 'running',
                    generation: 5,
                    reason: 'want-not-observed',
                    since: 1_500,
                    attempts: 5,
                    blocked: true,
                },
            }],
            reachable: null,
        });

        // A machine dialling in is pushed to the client: it is the event the App waits for, and
        // asking for it on a timer is the probing this connection replaces.
        const before = hub.reply('machines').length;
        const second = await connectDaemon(relay.port);
        await until(() => second.frames.some((f) => f.t === 'ok'));
        await until(() => hub.frames.filter((f) => f.t === 'machines').length > before);
        const latest = hub.frames.filter((f) => f.t === 'machines').at(-1);
        expect(latest.machines.map((m: { tag: string }) => m.tag)).toContain(second.tag);
    });

    /**
     * The republishes are not edges.
     *
     * Each daemon re-reads its list on a timer and publishes whenever anything in it moved — even a
     * field the directory does not carry. Broadcasting each one put a burst on the same connection a
     * stream handshake is waiting on, so a directory that says exactly what was last said is not
     * sent again.
     */
    it('does not push a republished directory that says the same thing', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        d.ws.send(JSON.stringify({ t: 'sessions', sessions: [{ happySessionId: 's1', isAlive: true, metadata: 'v1' }] }));
        const hub = await connectHub(relay.port);
        // The hub's connect frame is not a broadcast; the first republish after it is.
        d.ws.send(JSON.stringify({ t: 'sessions', sessions: [{ happySessionId: 's1', isAlive: true, metadata: 'v1' }] }));
        await until(() => hub.frames.filter((f) => f.t === 'machines').length === 1);
        const afterFirst = hub.frames.filter((f) => f.t === 'machines').length;

        // Only a field the directory does not carry changed: nothing a client can tell apart.
        d.ws.send(JSON.stringify({ t: 'sessions', sessions: [{ happySessionId: 's1', isAlive: true, metadata: 'v2' }] }));
        await Bun.sleep(250);
        expect(hub.frames.filter((f) => f.t === 'machines').length).toBe(afterFirst);

        // A fact it does carry still goes out on the next tick.
        d.ws.send(JSON.stringify({ t: 'sessions', sessions: [{ happySessionId: 's1', isAlive: false, metadata: 'v2' }] }));
        await until(() => hub.frames.filter((f) => f.t === 'machines').length === afterFirst + 1);
        expect(hub.frames.filter((f) => f.t === 'machines').at(-1).machines[0].sessions).toEqual([
            { happySessionId: 's1', isAlive: false },
        ]);
    });

    /**
     * The directory is state, and a client that can fetch it over HTTP should not also be handed it
     * on the connection its streams ride: an idempotent read can be revalidated with a 304, while a
     * snapshot pushed into an ordered stream delays whatever is queued behind it.
     *
     * Both shapes stay, because a client that does not ask for the HTTP one must keep working.
     */
    it('serves the directory over HTTP, marked with an etag that makes an unchanged read free', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        d.ws.send(JSON.stringify({ t: 'sessions', sessions: [{ happySessionId: 's1', isAlive: true }] }));
        // A separate connection: the publish has to have been handled on the daemon's socket first.
        await Bun.sleep(50);

        const res = await fetch(`http://127.0.0.1:${relay.port}/machines`);
        expect(res.status).toBe(200);
        const etag = res.headers.get('etag');
        expect(etag).toBeTruthy();
        expect(await res.json()).toEqual({ machines: [{ tag: d.tag, sessions: [{ happySessionId: 's1', isAlive: true }], reachable: null }] });

        const again = await fetch(`http://127.0.0.1:${relay.port}/machines`, { headers: { 'if-none-match': etag! } });
        expect(again.status).toBe(304);
        expect(await again.text()).toBe('');
    });

    it('tells an HTTP-directory client that the directory moved, and leaves the copy with the rest', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        const httpClient = await connectHub(relay.port, 'http');
        const legacy = await connectHub(relay.port, 'legacy');

        // The HTTP client was told the directory's fingerprint at connect, not its contents.
        const ok = httpClient.reply('ok')[0];
        expect(ok.machines).toBeUndefined();
        expect(typeof ok.etag).toBe('string');

        d.ws.send(JSON.stringify({ t: 'sessions', sessions: [{ happySessionId: 's1', isAlive: true }] }));
        await until(() => httpClient.reply('dir').length === 1 && legacy.reply('machines').length === 1);

        const nudge = httpClient.reply('dir')[0];
        // The nudge names the same representation the HTTP route would answer with, so a client
        // that already has it fetches nothing.
        const fetched = await fetch(`http://127.0.0.1:${relay.port}/machines`);
        expect(nudge.etag).toBe(fetched.headers.get('etag'));
        // The legacy client is not left behind: same fact, carried the way it can read it.
        expect(legacy.reply('machines')[0].machines[0].sessions).toEqual([{ happySessionId: 's1', isAlive: true }]);
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

    /**
     * The raw pipe.
     *
     * The daemon uses this to reach a SOCKS5 hop that only the relay can dial; the relay is a
     * byte pipe and deliberately knows nothing about SOCKS5 or about what is being proxied. What
     * these tests pin down is that the pipe carries bytes in both directions, that the daemon is
     * told when it cannot have one, and that a pipe never outlives the connection that owns it.
     */
    it('pipes bytes to a target the daemon names, crediting both directions', async () => {
        relay = startRelay({ port: 0 });
        const target = await startEchoTarget();
        try {
            const d = await connectDaemon(relay.port);
            await until(() => d.frames.some((f) => f.t === 'ok'));

            d.ws.send(JSON.stringify({ t: 'eg-open', id: 1, host: '127.0.0.1', port: target.port }));
            await until(() => d.frames.some((f) => f.t === 'eg-ok'));
            expect(d.frames.some((f) => f.t === 'eg-ok')).toBe(true);
            expect(target.sockets.size).toBe(1);

            d.ws.send(JSON.stringify({ t: 'eg-data', id: 1, d: Buffer.from('hello').toString('base64') }));
            await until(() => d.frames.some((f) => f.t === 'eg-data'));
            // The echo comes back as the same base64 the daemon sent.
            const echoed = Buffer.from(d.frames.find((f) => f.t === 'eg-data').d, 'base64').toString();
            expect(echoed).toBe('hello');
            // And the bytes it handed over are credited once they have left for the target, which
            // is what keeps the daemon from growing an unbounded queue here.
            await until(() => d.frames.some((f) => f.t === 'eg-credit'));
            expect(d.frames.find((f) => f.t === 'eg-credit')).toMatchObject({ id: 1, n: 5 });

            d.ws.send(JSON.stringify({ t: 'eg-close', id: 1 }));
            await until(() => target.sockets.size === 0);
            expect(target.sockets.size).toBe(0);
        } finally {
            await target.close();
        }
    });

    it('answers a connect that cannot be made rather than leaving the daemon waiting', async () => {
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));

        // Port 1 on loopback: no listener, and connecting is refused rather than timing out.
        d.ws.send(JSON.stringify({ t: 'eg-open', id: 7, host: '127.0.0.1', port: 1 }));
        await until(() => d.frames.some((f) => f.t === 'eg-err'));
        expect(d.frames.find((f) => f.t === 'eg-err')).toMatchObject({ id: 7 });
    });

    it('caps how many pipes one daemon can hold', async () => {
        relay = startRelay({ port: 0 });
        const target = await startEchoTarget();
        try {
            const d = await connectDaemon(relay.port);
            await until(() => d.frames.some((f) => f.t === 'ok'));
            for (let i = 0; i < 33; i++) {
                d.ws.send(JSON.stringify({ t: 'eg-open', id: i, host: '127.0.0.1', port: target.port }));
            }
            await until(() => d.frames.filter((f) => f.t === 'eg-ok' || f.t === 'eg-err').length >= 33);
            expect(d.frames.filter((f) => f.t === 'eg-ok')).toHaveLength(32);
            expect(d.frames.filter((f) => f.t === 'eg-err')).toHaveLength(1);
            expect(d.frames.find((f) => f.t === 'eg-err')).toMatchObject({ message: 'too many streams' });
        } finally {
            await target.close();
        }
    });

    it('closes every pipe when the daemon that owns them goes away', async () => {
        relay = startRelay({ port: 0 });
        const target = await startEchoTarget();
        try {
            const d = await connectDaemon(relay.port);
            await until(() => d.frames.some((f) => f.t === 'ok'));
            d.ws.send(JSON.stringify({ t: 'eg-open', id: 3, host: '127.0.0.1', port: target.port }));
            await until(() => d.frames.some((f) => f.t === 'eg-ok'));
            expect(target.sockets.size).toBe(1);

            d.ws.close();
            await until(() => target.sockets.size === 0);
            expect(target.sockets.size).toBe(0);
        } finally {
            await target.close();
        }
    });

    /**
     * A route is this relay's own definition: the daemon names it, the relay dials its hop and
     * speaks SOCKS5. The machine learns the route's name and nothing else, which is the whole
     * point — one place holds the address and its credentials.
     */
    it('keeps a pool of egress lanes beside the control connection', async () => {
        // Two connections, one machine. A lane carries pipes only, and registering one must not
        // evict the control connection the App's routes depend on.
        const target = await startEchoTarget();
        try {
            relay = startRelay({ port: 0 });
            const pair = nacl.sign.keyPair();
            const control = await connectDaemon(relay.port, pair);
            await until(() => control.frames.some((f) => f.t === 'ok'));

            const lane = await connectDaemon(relay.port, pair, true, { lane: 'egress', slot: 1 });
            await until(() => lane.frames.some((f) => f.t === 'ok'));
            expect(lane.frames.find((f) => f.t === 'ok').lane).toBe('egress');

            lane.ws.send(JSON.stringify({ t: 'eg-open', id: 9, host: '127.0.0.1', port: target.port }));
            await until(() => lane.frames.some((f) => f.t === 'eg-ok' || f.t === 'eg-err'));
            expect(lane.frames.some((f) => f.t === 'eg-ok')).toBe(true);
            // The lane registers as a second socket but the machine is still counted once.
            expect(relay.daemonCount()).toBe(1);
        } finally {
            await target.close();
        }
    });

    it('answers a daemon heartbeat and advertises that it does', async () => {
        // The Bun client cannot observe control-frame pongs, so liveness has to be made of frames
        // it can read. The advertisement is what keeps an older relay from being pinged forever.
        relay = startRelay({ port: 0 });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));
        expect(d.frames.find((f) => f.t === 'ok').features).toContain('ping');

        d.ws.send(JSON.stringify({ t: 'ping' }));
        await until(() => d.frames.some((f) => f.t === 'pong'));
        expect(d.frames.find((f) => f.t === 'pong')).toMatchObject({ t: 'pong' });
    });

    it('carries a pipe through a named route without ever seeing the hop on the daemon', async () => {
        const target = await startEchoTarget();
        const hop = await startSocks5Hop();
        try {
            relay = startRelay({ port: 0, routes: { personal: `socks5h://127.0.0.1:${hop.port}` } });
            const d = await connectDaemon(relay.port);
            await until(() => d.frames.some((f) => f.t === 'ok'));

            // What a machine is told: the names, never the addresses.
            await until(() => d.frames.some((f) => f.t === 'routes'));
            expect(d.frames.find((f) => f.t === 'routes').names).toEqual(['personal']);

            d.ws.send(JSON.stringify({ t: 'eg-open', id: 1, route: 'personal', host: '127.0.0.1', port: target.port }));
            await until(() => d.frames.some((f) => f.t === 'eg-ok'));
            expect(d.frames.some((f) => f.t === 'eg-ok')).toBe(true);
            // The hop is what carried it: the relay connected there, and asked for the target.
            expect(hop.requests).toEqual([{ host: '127.0.0.1', port: target.port }]);
            expect(target.sockets.size).toBe(1);

            d.ws.send(JSON.stringify({ t: 'eg-data', id: 1, d: Buffer.from('via route').toString('base64') }));
            await until(() => d.frames.some((f) => f.t === 'eg-data'));
            expect(Buffer.from(d.frames.find((f) => f.t === 'eg-data').d, 'base64').toString()).toBe('via route');

            d.ws.send(JSON.stringify({ t: 'eg-close', id: 1 }));
            await until(() => target.sockets.size === 0);
            expect(target.sockets.size).toBe(0);
        } finally {
            await hop.close();
            await target.close();
        }
    });

    it('serves a route with no hop by dialling the target from the relay', async () => {
        const target = await startEchoTarget();
        try {
            // null is a route, not a missing one: the relay's own way out, chosen by name.
            relay = startRelay({ port: 0, routes: { direct: null } });
            const d = await connectDaemon(relay.port);
            await until(() => d.frames.some((f) => f.t === 'ok'));
            await until(() => d.frames.some((f) => f.t === 'routes'));
            expect(d.frames.find((f) => f.t === 'routes').names).toEqual(['direct']);

            d.ws.send(JSON.stringify({ t: 'eg-open', id: 5, route: 'direct', host: '127.0.0.1', port: target.port }));
            await until(() => d.frames.some((f) => f.t === 'eg-ok'));
            expect(d.frames.some((f) => f.t === 'eg-ok')).toBe(true);

            d.ws.send(JSON.stringify({ t: 'eg-data', id: 5, d: Buffer.from('direct').toString('base64') }));
            await until(() => d.frames.some((f) => f.t === 'eg-data'));
            expect(Buffer.from(d.frames.find((f) => f.t === 'eg-data').d, 'base64').toString()).toBe('direct');
        } finally {
            await target.close();
        }
    });

    it('refuses an unknown route instead of dialling the target itself', async () => {
        relay = startRelay({ port: 0, routes: { personal: 'socks5h://127.0.0.1:1' } });
        const d = await connectDaemon(relay.port);
        await until(() => d.frames.some((f) => f.t === 'ok'));

        d.ws.send(JSON.stringify({ t: 'eg-open', id: 2, route: 'not-defined', host: '127.0.0.1', port: 9 }));
        await until(() => d.frames.some((f) => f.t === 'eg-err'));
        expect(d.frames.find((f) => f.t === 'eg-err')).toMatchObject({ id: 2, message: 'unknown route' });
    });

    it('authenticates to the hop when the route carries credentials', async () => {
        const target = await startEchoTarget();
        const hop = await startSocks5Hop({ user: 'user-1', pass: 'pass-1' });
        try {
            relay = startRelay({ port: 0, routes: { personal: `socks5h://user-1:pass-1@127.0.0.1:${hop.port}` } });
            const d = await connectDaemon(relay.port);
            await until(() => d.frames.some((f) => f.t === 'ok'));

            d.ws.send(JSON.stringify({ t: 'eg-open', id: 4, route: 'personal', host: '127.0.0.1', port: target.port }));
            await until(() => d.frames.some((f) => f.t === 'eg-ok' || f.t === 'eg-err'));
            expect(d.frames.find((f) => f.t === 'eg-ok')).toMatchObject({ id: 4 });
            expect(hop.requests).toEqual([{ host: '127.0.0.1', port: target.port }]);
        } finally {
            await hop.close();
            await target.close();
        }
    });
});
