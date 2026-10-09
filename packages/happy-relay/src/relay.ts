/**
 * A stateless relay for the daemon's LAN API.
 *
 * A daemon dials out to `/daemon` and proves ownership of a tag (the hash of an ed25519 public key
 * derived from its machine key). An App then talks to `/r/<tag>/<lan path>` and the relay forwards
 * each HTTP request / WebSocket frame down that one control connection. The relay stores nothing and
 * never holds a credential: the LAN protocol's own HMAC challenge-response still decides access, and
 * session content is ciphertext end to end.
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
    httpTimeoutMs?: number;
    /** Requests per IP per minute on the public side. */
    ratePerMinute?: number;
};

export type RelayHandle = { port: number; stop: () => void; daemonCount: () => number };

type Pending = { resolve: (res: Response) => void; timer: ReturnType<typeof setTimeout> };

type Daemon = {
    tag: string;
    ws: any;
    pending: Map<number, Pending>;
    clients: Map<number, any>;
    nextId: number;
};

type SocketData =
    | { kind: 'daemon'; nonce: string; tag: string | null }
    | { kind: 'client'; tag: string; id: number; path: string; ip: string };

export function tagOfPublicKey(pub: Uint8Array): string {
    return createHash('sha256').update(pub).digest('hex').slice(0, 32);
}

const TAG_RE = /^[0-9a-f]{32}$/;
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive']);

export function startRelay(options: RelayOptions): RelayHandle {
    const maxBody = options.maxBodyBytes ?? 4 * 1024 * 1024;
    const httpTimeout = options.httpTimeoutMs ?? 15_000;
    const rate = options.ratePerMinute ?? 600;
    const daemons = new Map<string, Daemon>();
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
            maxPayloadLength: maxBody,
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
                    const daemon: Daemon = { tag, ws, pending: new Map(), clients: new Map(), nextId: 1 };
                    daemons.set(tag, daemon);
                    data.tag = tag;
                    if (previous && previous.ws !== ws) {
                        teardown(previous);
                        try { previous.ws.close(4000, 'replaced'); } catch { /* gone */ }
                    }
                    ws.send(JSON.stringify({ t: 'ok', tag }));
                    return;
                }

                const daemon = daemons.get(data.tag);
                if (!daemon || daemon.ws !== ws) return;
                if (msg.t === 'http-res') {
                    const p = daemon.pending.get(msg.id);
                    if (!p) return;
                    clearTimeout(p.timer);
                    daemon.pending.delete(msg.id);
                    const headers = new Headers(msg.headers ?? {});
                    headers.set('access-control-allow-origin', '*');
                    headers.delete('content-length');
                    const body = msg.body ? Buffer.from(String(msg.body), 'base64') : null;
                    p.resolve(new Response(body, { status: Number(msg.status) || 502, headers }));
                } else if (msg.t === 'ws-msg') {
                    daemon.clients.get(msg.id)?.send(String(msg.data));
                } else if (msg.t === 'ws-close') {
                    const c = daemon.clients.get(msg.id);
                    daemon.clients.delete(msg.id);
                    try { c?.close(Number(msg.code) >= 4000 ? Number(msg.code) : 1000, String(msg.reason ?? '')); } catch { /* gone */ }
                }
            },
            close(ws) {
                const data = ws.data;
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
                    }
                }
            },
        },
    });

    function teardown(daemon: Daemon) {
        for (const p of daemon.pending.values()) {
            clearTimeout(p.timer);
            p.resolve(json(502, { error: 'offline' }));
        }
        daemon.pending.clear();
        for (const c of daemon.clients.values()) {
            try { c.close(4502, 'offline'); } catch { /* gone */ }
        }
        daemon.clients.clear();
    }

    return {
        port: server.port,
        stop: () => { clearInterval(sweep); server.stop(true); },
        daemonCount: () => daemons.size,
    };
}
