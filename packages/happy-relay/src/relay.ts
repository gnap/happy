/**
 * A relay for the daemon's LAN API, addressed two ways.
 *
 * A daemon dials out to `/daemon` and proves ownership of a tag (the hash of an ed25519 public key
 * derived from its machine key). From there:
 *
 * - `/r/<tag>/<lan path>` — one connection per tag, which is how an App reaches one machine. This
 *   is the original shape and is kept exactly as it was.
 * - `/client` — **one** connection for the whole App, which addresses any machine on it with
 *   `{t:'open', tag, path}` and asks for the directory with `{t:'machines'}`. This is the shape the
 *   App wants: the relay is a hub over machines and their sessions, the way the server is, so the
 *   App does not have to hold a connection per machine, probe each one to find out whether it is
 *   up, or derive per-machine addresses.
 *
 * The relay still stores nothing durable and never holds a credential: the LAN protocol's own HMAC
 * challenge-response decides access, session content is ciphertext end to end, and what it caches is
 * only what the daemons themselves publish as a directory (session ids and their summary lines —
 * the same thing `GET /lan/sessions` already returns through this relay).
 */
import nacl from 'tweetnacl';
import { createHash, randomBytes } from 'node:crypto';

export const REGISTER_CONTEXT = 'happy-relay-v1.register.';

export type RelayOptions = {
    port: number;
    hostname?: string;
    tls?: { certFile: string; keyFile: string };
    /** Max request/response body in bytes. */
    maxBodyBytes?: number;
    /**
     * Max WebSocket frame in bytes. Separate from the body limit because the two carry different
     * things: a request body is one message the App chose to send, while a frame may be a page of a
     * session's log, which the daemon sizes. Bun closes the whole connection when a frame exceeds
     * it, so this must stay comfortably above the daemon's page size.
     */
    maxFrameBytes?: number;
    httpTimeoutMs?: number;
    /** Requests per IP per minute on the public side. */
    ratePerMinute?: number;
};

export type RelayHandle = { port: number; stop: () => void; daemonCount: () => number };

/** An HTTP request awaiting its answer. One of the two consumers owns the reply. */
type Pending = {
    timer: ReturnType<typeof setTimeout>;
    /** The `/r/<tag>/…` path answers by resolving the fetch with a Response. */
    resolve?: (res: Response) => void;
    /** The hub path answers by sending the daemon's own response object back to its client. */
    hub?: { client: any; clientId: number };
};

type Daemon = {
    tag: string;
    ws: any;
    pending: Map<number, Pending>;
    /** Proxied sockets opened through `/r/<tag>/…`, keyed by the id this relay handed the daemon. */
    clients: Map<number, any>;
    /** Streams opened through `/hub`, keyed the same way, each remembering which client wants it. */
    hub: Map<number, { client: any; clientId: number }>;
    /** The session summary this daemon last published, for the directory. */
    sessions: unknown[];
    nextId: number;
};

type SocketData =
    | { kind: 'daemon'; nonce: string; tag: string | null }
    | { kind: 'client'; tag: string; id: number; path: string; ip: string }
    | {
          kind: 'hub';
          ip: string;
          /** Every stream this client has open, by the id *it* chose: where its frames go. */
          streams: Map<number, { tag: string; daemonId: number }>;
      };

export function tagOfPublicKey(pub: Uint8Array): string {
    return createHash('sha256').update(pub).digest('hex').slice(0, 32);
}

const TAG_RE = /^[0-9a-f]{32}$/;
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive']);

export function startRelay(options: RelayOptions): RelayHandle {
    const maxBody = options.maxBodyBytes ?? 4 * 1024 * 1024;
    const maxFrame = options.maxFrameBytes ?? 8 * 1024 * 1024;
    const httpTimeout = options.httpTimeoutMs ?? 15_000;
    const rate = options.ratePerMinute ?? 600;
    const daemons = new Map<string, Daemon>();
    /** Hub connections, so the directory can be pushed the moment a machine comes or goes. */
    const hubClients = new Set<any>();
    const hits = new Map<string, { count: number; reset: number }>();

    const limited = (ip: string): boolean => {
        const now = Date.now();
        const entry = hits.get(ip);
        if (!entry || entry.reset < now) {
            hits.set(ip, { count: 1, reset: now + 60_000 });
            return false;
        }
        entry.count += 1;
        return entry.count > rate;
    };
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [ip, e] of hits) {
            if (e.reset < now) hits.delete(ip);
        }
    }, 60_000);
    sweep.unref?.();

    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });

    const server = Bun.serve<SocketData>({
        port: options.port,
        hostname: options.hostname,
        tls: options.tls ? { cert: Bun.file(options.tls.certFile), key: Bun.file(options.tls.keyFile) } : undefined,
        maxRequestBodySize: maxBody,
        async fetch(req, srv) {
            const url = new URL(req.url);
            const ip = srv.requestIP(req)?.address ?? 'unknown';

            if (url.pathname === '/health') {
                return json(200, { ok: true, daemons: daemons.size });
            }
            if (url.pathname === '/client') {
                if (limited(ip)) return json(429, { error: 'rate' });
                const ok = srv.upgrade(req, { data: { kind: 'hub', ip, streams: new Map() } as SocketData });
                return ok ? undefined : json(400, { error: 'upgrade' });
            }
            if (url.pathname === '/daemon') {
                if (limited(ip)) return json(429, { error: 'rate' });
                const ok = srv.upgrade(req, { data: { kind: 'daemon', nonce: randomBytes(24).toString('base64url'), tag: null } as SocketData });
                return ok ? undefined : json(400, { error: 'upgrade' });
            }

            const match = url.pathname.match(/^\/r\/([^/]+)(\/.*)?$/);
            if (!match) return json(404, { error: 'not found' });
            const tag = match[1];
            const rest = (match[2] ?? '/') + url.search;
            if (!TAG_RE.test(tag)) return json(404, { error: 'not found' });

            if (req.method === 'OPTIONS') {
                return new Response(null, {
                    status: 204,
                    headers: {
                        'access-control-allow-origin': '*',
                        'access-control-allow-headers': 'authorization,content-type',
                        'access-control-allow-methods': 'GET,POST,OPTIONS',
                    },
                });
            }
            if (limited(ip)) return json(429, { error: 'rate' });
            const daemon = daemons.get(tag);
            if (!daemon) return json(502, { error: 'offline' });

            if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                const ok = srv.upgrade(req, { data: { kind: 'client', tag, id: 0, path: rest, ip } as SocketData });
                return ok ? undefined : json(400, { error: 'upgrade' });
            }

            const bodyBuf = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer());
            const headers: Record<string, string> = {};
            req.headers.forEach((v, k) => {
                if (!HOP_HEADERS.has(k)) headers[k] = v;
            });
            const id = daemon.nextId++;
            return new Promise<Response>((resolve) => {
                const timer = setTimeout(() => {
                    daemon.pending.delete(id);
                    resolve(json(504, { error: 'timeout' }));
                }, httpTimeout);
                daemon.pending.set(id, { resolve, timer });
                try {
                    daemon.ws.send(JSON.stringify({
                        t: 'http', id, method: req.method, path: rest, headers, ip,
                        body: bodyBuf ? Buffer.from(bodyBuf).toString('base64') : null,
                    }));
                } catch {
                    clearTimeout(timer);
                    daemon.pending.delete(id);
                    resolve(json(502, { error: 'offline' }));
                }
            });
        },
        websocket: {
            maxPayloadLength: maxFrame,
            idleTimeout: 120,
            sendPings: true,
            open(ws) {
                const data = ws.data;
                if (data.kind === 'daemon') {
                    ws.send(JSON.stringify({ t: 'challenge', nonce: data.nonce }));
                    // An unauthenticated control socket must not linger.
                    setTimeout(() => { if (ws.data.kind === 'daemon' && !ws.data.tag) ws.close(4401, 'auth timeout'); }, 5_000);
                    return;
                }
                if (data.kind === 'hub') {
                    // The connection itself carries no credential — the daemons authenticate every
                    // request that reaches them — so there is nothing to prove here and nothing to
                    // wait for. The directory comes first because it is what a client is for.
                    hubClients.add(ws);
                    ws.send(JSON.stringify({ t: 'ok', machines: directory() }));
                    return;
                }
                const daemon = daemons.get(data.tag);
                if (!daemon) {
                    ws.close(4502, 'offline');
                    return;
                }
                data.id = daemon.nextId++;
                daemon.clients.set(data.id, ws);
                daemon.ws.send(JSON.stringify({ t: 'ws-open', id: data.id, path: data.path, ip: data.ip }));
            },
            message(ws, raw) {
                const data = ws.data;
                if (data.kind === 'client') {
                    const daemon = daemons.get(data.tag);
                    if (!daemon || typeof raw !== 'string') return;
                    daemon.ws.send(JSON.stringify({ t: 'ws-msg', id: data.id, data: raw }));
                    return;
                }
                if (data.kind === 'hub') {
                    if (typeof raw !== 'string') return;
                    let frame: any;
                    try { frame = JSON.parse(raw); } catch { return; }
                    hubFrame(ws, data, frame);
                    return;
                }
                let msg: any;
                try { msg = JSON.parse(String(raw)); } catch { return; }

                if (!data.tag) {
                    if (msg.t !== 'register' || typeof msg.pub !== 'string' || typeof msg.sig !== 'string') {
                        ws.close(4401, 'bad register');
                        return;
                    }
                    const pub = Buffer.from(msg.pub, 'base64');
                    const sig = Buffer.from(msg.sig, 'base64');
                    const valid = pub.length === 32 && sig.length === 64 &&
                        nacl.sign.detached.verify(Buffer.from(REGISTER_CONTEXT + data.nonce), sig, pub);
                    if (!valid) {
                        ws.close(4401, 'bad signature');
                        return;
                    }
                    const tag = tagOfPublicKey(pub);
                    // The signature proves key ownership, so a newer connection from the same key
                    // legitimately replaces a stale one (daemon restart / NAT rebinding).
                    const previous = daemons.get(tag);
                    const daemon: Daemon = { tag, ws, pending: new Map(), clients: new Map(), hub: new Map(), sessions: [], nextId: 1 };
                    daemons.set(tag, daemon);
                    data.tag = tag;
                    if (previous && previous.ws !== ws) {
                        teardown(previous);
                        try { previous.ws.close(4000, 'replaced'); } catch { /* gone */ }
                    }
                    ws.send(JSON.stringify({ t: 'ok', tag }));
                    // A machine coming online is the event an App is waiting for, so it is pushed
                    // rather than left for the client to notice on a timer.
                    broadcastDirectory();
                    return;
                }

                const daemon = daemons.get(data.tag);
                if (!daemon || daemon.ws !== ws) return;
                if (msg.t === 'http-res') {
                    const p = daemon.pending.get(msg.id);
                    if (!p) return;
                    clearTimeout(p.timer);
                    daemon.pending.delete(msg.id);
                    if (p.hub) {
                        try {
                            p.hub.client.send(JSON.stringify({
                                t: 'http-res',
                                id: p.hub.clientId,
                                status: Number(msg.status) || 502,
                                headers: msg.headers ?? {},
                                body: msg.body ?? null,
                            }));
                        } catch { /* the client is gone; its own close handler cleans up */ }
                        return;
                    }
                    const headers = new Headers(msg.headers ?? {});
                    headers.set('access-control-allow-origin', '*');
                    headers.delete('content-length');
                    const body = msg.body ? Buffer.from(String(msg.body), 'base64') : null;
                    p.resolve?.(new Response(body, { status: Number(msg.status) || 502, headers }));
                } else if (msg.t === 'ws-msg') {
                    const stream = daemon.hub.get(msg.id);
                    if (stream) {
                        try { stream.client.send(JSON.stringify({ t: 'msg', id: stream.clientId, data: msg.data })); } catch { /* gone */ }
                        return;
                    }
                    daemon.clients.get(msg.id)?.send(String(msg.data));
                } else if (msg.t === 'ws-close') {
                    const stream = daemon.hub.get(msg.id);
                    if (stream) {
                        daemon.hub.delete(msg.id);
                        try { stream.client.send(JSON.stringify({ t: 'close', id: stream.clientId, code: msg.code, reason: msg.reason })); } catch { /* gone */ }
                        return;
                    }
                    const c = daemon.clients.get(msg.id);
                    daemon.clients.delete(msg.id);
                    try { c?.close(Number(msg.code) >= 4000 ? Number(msg.code) : 1000, String(msg.reason ?? '')); } catch { /* gone */ }
                } else if (msg.t === 'sessions') {
                    // What the machine publishes for the directory. It is the daemon's own summary of
                    // its sessions — no content, nothing this relay could not already read off the
                    // wire — and it is what lets an App list sessions without asking each machine.
                    daemon.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
                    broadcastDirectory();
                }
            },
            close(ws) {
                const data = ws.data;
                if (data.kind === 'hub') {
                    hubClients.delete(ws);
                    // Every stream this client opened is a socket on some daemon; the daemon has to be
                    // told, or it keeps a reader that will never be read from again.
                    for (const stream of data.streams.values()) {
                        const daemon = daemons.get(stream.tag);
                        if (!daemon) continue;
                        daemon.hub.delete(stream.daemonId);
                        try { daemon.ws.send(JSON.stringify({ t: 'ws-close', id: stream.daemonId })); } catch { /* gone */ }
                    }
                    data.streams.clear();
                    return;
                }
                if (data.kind === 'client') {
                    const daemon = daemons.get(data.tag);
                    if (daemon?.clients.delete(data.id)) {
                        try { daemon.ws.send(JSON.stringify({ t: 'ws-close', id: data.id })); } catch { /* gone */ }
                    }
                    return;
                }
                if (data.tag) {
                    const daemon = daemons.get(data.tag);
                    if (daemon && daemon.ws === ws) {
                        daemons.delete(data.tag);
                        teardown(daemon);
                        broadcastDirectory();
                    }
                }
            },
        },
    });

    /** What a client can reach: every daemon that is dialled in, with the sessions it published. */
    function directory(): { tag: string; sessions: unknown[] }[] {
        return [...daemons.values()].map((daemon) => ({ tag: daemon.tag, sessions: daemon.sessions }));
    }

    /**
     * Tells every hub client the directory changed.
     *
     * Pushed rather than left to be polled: a machine coming online is exactly the event an App
     * wants to hear about, and asking for it on a timer is the probing this connection exists to
     * replace.
     */
    function broadcastDirectory(): void {
        if (hubClients.size === 0) return;
        const frame = JSON.stringify({ t: 'machines', machines: directory() });
        for (const client of hubClients) {
            try { client.send(frame); } catch { /* gone */ }
        }
    }

    function hubFrame(ws: any, data: { ip: string; streams: Map<number, { tag: string; daemonId: number }> }, frame: any): void {
        const reply = (body: unknown) => { try { ws.send(JSON.stringify(body)); } catch { /* gone */ } };

        if (frame.t === 'machines') {
            reply({ t: 'machines', machines: directory() });
            return;
        }

        // The client's own liveness check on this one connection. A machine's liveness is this
        // relay's business, not the client's — it holds the daemon's connection — but whether the
        // client's own connection is still carrying anything is only knowable here.
        if (frame.t === 'ping') {
            reply({ t: 'pong' });
            return;
        }

        if (frame.t === 'open' && typeof frame.id === 'number' && typeof frame.tag === 'string' && typeof frame.path === 'string') {
            const daemon = daemons.get(frame.tag);
            if (!daemon) {
                reply({ t: 'close', id: frame.id, code: 4502, reason: 'offline' });
                return;
            }
            const daemonId = daemon.nextId++;
            daemon.hub.set(daemonId, { client: ws, clientId: frame.id });
            data.streams.set(frame.id, { tag: frame.tag, daemonId });
            daemon.ws.send(JSON.stringify({ t: 'ws-open', id: daemonId, path: frame.path, ip: data.ip }));
            return;
        }

        if (frame.t === 'msg' && typeof frame.id === 'number' && typeof frame.data === 'string') {
            const stream = data.streams.get(frame.id);
            const daemon = stream ? daemons.get(stream.tag) : undefined;
            if (!stream || !daemon) {
                reply({ t: 'close', id: frame.id, code: 4502, reason: 'offline' });
                return;
            }
            daemon.ws.send(JSON.stringify({ t: 'ws-msg', id: stream.daemonId, data: frame.data }));
            return;
        }

        if (frame.t === 'close' && typeof frame.id === 'number') {
            const stream = data.streams.get(frame.id);
            data.streams.delete(frame.id);
            const daemon = stream ? daemons.get(stream.tag) : undefined;
            if (!stream || !daemon) return;
            daemon.hub.delete(stream.daemonId);
            daemon.ws.send(JSON.stringify({ t: 'ws-close', id: stream.daemonId, code: frame.code, reason: frame.reason }));
            return;
        }

        if (frame.t === 'http' && typeof frame.id === 'number' && typeof frame.tag === 'string' && typeof frame.path === 'string') {
            const daemon = daemons.get(frame.tag);
            if (!daemon) {
                reply({ t: 'http-res', id: frame.id, status: 502, headers: {}, body: null });
                return;
            }
            const daemonId = daemon.nextId++;
            const timer = setTimeout(() => {
                daemon.pending.delete(daemonId);
                reply({ t: 'http-res', id: frame.id, status: 504, headers: {}, body: null });
            }, httpTimeout);
            daemon.pending.set(daemonId, { timer, hub: { client: ws, clientId: frame.id } });
            try {
                daemon.ws.send(JSON.stringify({
                    t: 'http',
                    id: daemonId,
                    method: String(frame.method ?? 'GET'),
                    path: frame.path,
                    headers: frame.headers ?? {},
                    ip: data.ip,
                    body: frame.body ?? null,
                }));
            } catch {
                clearTimeout(timer);
                daemon.pending.delete(daemonId);
                reply({ t: 'http-res', id: frame.id, status: 502, headers: {}, body: null });
            }
        }
    }

    function teardown(daemon: Daemon) {
        for (const p of daemon.pending.values()) {
            clearTimeout(p.timer);
            if (p.hub) {
                try { p.hub.client.send(JSON.stringify({ t: 'http-res', id: p.hub.clientId, status: 502, headers: {}, body: null })); } catch { /* gone */ }
                continue;
            }
            p.resolve?.(json(502, { error: 'offline' }));
        }
        daemon.pending.clear();
        for (const stream of daemon.hub.values()) {
            try { stream.client.send(JSON.stringify({ t: 'close', id: stream.clientId, code: 4502, reason: 'offline' })); } catch { /* gone */ }
        }
        daemon.hub.clear();
        for (const c of daemon.clients.values()) {
            try { c.close(4502, 'offline'); } catch { /* gone */ }
        }
        daemon.clients.clear();
    }

    return {
        // Bun reports the bound port only once listening; the requested one is what it bound unless
        // it was 0, in which case the OS chose and `server.port` has it.
        port: server.port ?? options.port,
        stop: () => { clearInterval(sweep); server.stop(true); },
        daemonCount: () => daemons.size,
    };
}
