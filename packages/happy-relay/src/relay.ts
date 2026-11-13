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
 * only what the daemons themselves publish as a directory (session ids, their summary lines, and the
 * addresses each machine says it can be reached at — the same things the daemon's own LAN API
 * already returns through this relay).
 *
 * The addresses belong here because the relay is the one party still holding them when the server is
 * gone, which is the situation the relay exists for: an App that cannot read the server's copy of a
 * machine's metadata can still learn where that machine is on the LAN and go straight to it.
 */
import nacl from 'tweetnacl';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

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
    /** What was asked, so the answer can be reported without the caller having to log anything. */
    request?: { tag: string; method: string; path: string };
};

/**
 * One line per read of a session's own routes, written when the daemon answers.
 *
 * The App's reads leave no trace anywhere an operator can see: they travel a socket to the machine
 * and the answer comes back the same way. When a screen that reads from a session is empty, the
 * question is always the same — did the request go out, and what did the machine say — and this is
 * the only place the whole exchange is visible. Session routes only, and never the body itself:
 * a listing's file count is enough to tell an empty directory from an unanswered request.
 */
function logSessionRead(request: Pending['request'], status: number, bodyBase64: string | null): void {
    if (!request || !request.path.includes('/lan/sessions/')) return;
    const body = bodyBase64 ? Buffer.from(bodyBase64, 'base64') : null;
    const bytes = body?.length ?? 0;
    let detail = '';
    if (body && status === 200 && request.path.includes('/listing')) {
        const sessionId = request.path.split('/lan/sessions/')[1]?.split('/')[0] ?? 'session';
        try {
            const parsed = JSON.parse(body.toString('utf8')) as {
                files?: unknown; gitRepo?: unknown; gitStatus?: unknown; gitDiff?: unknown; filesTruncated?: unknown;
            };
            const files = typeof parsed.files === 'string' ? parsed.files.split('\n').filter(Boolean).length : -1;
            const gitStatus = typeof parsed.gitStatus === 'string' ? parsed.gitStatus : '';
            const gitDiff = typeof parsed.gitDiff === 'string' ? parsed.gitDiff : '';
            detail = ` files=${files} fileBytes=${typeof parsed.files === 'string' ? parsed.files.length : -1}`
                + ` statusBytes=${gitStatus.length} diffBytes=${gitDiff.length}`
                + ` repo=${parsed.gitRepo === true} truncated=${parsed.filesTruncated === true}`
                // The paths in `git status` name the working tree the daemon actually answered for.
                + ` tree=${gitStatus.replace(/\n/g, ' | ').slice(0, 300)}`;
            mkdirSync('/tmp/relay-listings', { recursive: true });
            writeFileSync(`/tmp/relay-listings/${sessionId}.json`, body);
        } catch {
            // Not the listing's JSON — the status and size still say what happened.
        }
    }
    console.log(`[read] ${request.tag.slice(0, 8)} ${request.method} ${request.path.split('?')[0]} -> ${status} ${bytes}B${detail}`);
}

/**
 * What the directory says about one session.
 *
 * Deliberately not the daemon's whole summary. A client asks the directory for two facts — that a
 * session exists on this machine, and whether it is running — and everything larger (the encrypted
 * metadata and agent state) is what a read pulls over the session's own channel. Carrying those
 * here bought nothing and cost a megabyte per broadcast, sent to every connected App each time any
 * daemon's list moved: frames that large delay whatever is queued behind them on the same
 * connection, including the first frame of a stream being opened. The relay is also not the place
 * to hold a copy of state it never uses.
 */
type DirectorySession = {
    happySessionId?: string;
    /** The CLI's own tag, for a session the server has not named yet. */
    tag?: string;
    isAlive: boolean;
    /** Which machine the row is about: this one, or the daemon's import of the server's record. */
    origin?: 'daemon' | 'server';
};

/**
 * Narrows one published summary to a directory row, dropping anything unaddressable.
 *
 * A row without either name cannot be asked for by a client, so there is nothing it would add.
 */
function directorySession(entry: unknown): DirectorySession | null {
    if (!entry || typeof entry !== 'object') return null;
    const session = entry as { happySessionId?: unknown; tag?: unknown; isAlive?: unknown; origin?: unknown };
    const row: DirectorySession = { isAlive: session.isAlive === true };
    if (typeof session.happySessionId === 'string') row.happySessionId = session.happySessionId;
    if (typeof session.tag === 'string') row.tag = session.tag;
    if (row.happySessionId === undefined && row.tag === undefined) return null;
    if (session.origin === 'daemon' || session.origin === 'server') row.origin = session.origin;
    return row;
}

type Daemon = {
    tag: string;
    ws: any;
    pending: Map<number, Pending>;
    /** Proxied sockets opened through `/r/<tag>/…`, keyed by the id this relay handed the daemon. */
    clients: Map<number, any>;
    /** Streams opened through `/hub`, keyed the same way, each remembering which client wants it. */
    hub: Map<number, { client: any; clientId: number }>;
    /**
     * Where this daemon last said it can be reached, for the directory.
     *
     * Stored as it arrived and never decoded, like the session summary beside it: the relay is a
     * pipe, and the shape of an address is the daemon's business. What it buys is the case the
     * relay exists for — an App whose server is unreachable can still learn where the machine is
     * on the LAN, and connect to it directly.
     */
    reachable: unknown | null;
    /**
     * The session roster this daemon last published, narrowed to what the directory is for.
     *
     * The daemon publishes whole summaries — metadata and agent state included, because the same
     * list serves a LAN reader that opens a session's name from it. The directory serves a
     * different question: *which* sessions this machine holds and whether they are running. Keeping
     * the blobs here made the directory a megabyte and every hub client paid for it on each
     * republish, which is how a stream's first frame ended up queued behind them. See
     * `directorySession`.
     */
    sessions: DirectorySession[];

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
          /**
           * This client reads the directory over HTTP; the hub only tells it when that changed.
           *
           * A client says so by connecting to `/client?dir=http`. Older clients do not, and keep
           * receiving the directory as a frame — the hub is one connection for both shapes, and a
           * client that cannot ask must not be handed a protocol it does not speak.
           */
          directory?: 'http';
      };

export function tagOfPublicKey(pub: Uint8Array): string {
    return createHash('sha256').update(pub).digest('hex').slice(0, 32);
}

const TAG_RE = /^[0-9a-f]{32}$/;
/**
 * How long to gather a burst of per-machine republishes into one directory frame.
 *
 * The daemons' publish timers are independent, so several land together; 50ms is below anything a
 * reader could read as stale and above the burst. It is not a rate limit — an unchanged directory
 * is not sent at all, and a real change still goes out on the first tick after it happens.
 */
const DIRECTORY_BROADCAST_DELAY_MS = 50;
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive']);

export function startRelay(options: RelayOptions): RelayHandle {
    const maxBody = options.maxBodyBytes ?? 4 * 1024 * 1024;
    const maxFrame = options.maxFrameBytes ?? 8 * 1024 * 1024;
    const httpTimeout = options.httpTimeoutMs ?? 15_000;
    const rate = options.ratePerMinute ?? 600;
    const daemons = new Map<string, Daemon>();
    /** Hub connections, so the directory can be pushed the moment a machine comes or goes. */
    const hubClients = new Set<any>();
    /** The directory frame last pushed to hub clients, so a no-op republish sends nothing. */
    let lastDirectoryFrame: string | null = null;
    /** The one coalesced broadcast waiting to go out, if any. */
    let directoryBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
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

    /**
     * The headers a browser needs to be allowed to make the request at all. On every response. The
     * proof headers are here because an account-signed request is a browser POST carrying them, and
     * a preflight that does not name them is a refusal the daemon never sees — the caller reads it
     * as a machine that will not answer, and the action falls to a channel that cannot carry it.
     */
    const CORS = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers':
            'authorization,content-type,x-happy-proof-nonce,x-happy-proof-at,x-happy-proof-signature',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-max-age': '600',
    };

    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

    const server = Bun.serve<SocketData>({
        port: options.port,
        hostname: options.hostname,
        tls: options.tls ? { cert: Bun.file(options.tls.certFile), key: Bun.file(options.tls.keyFile) } : undefined,
        maxRequestBodySize: maxBody,
        async fetch(req, srv) {
            const url = new URL(req.url);
            const ip = srv.requestIP(req)?.address ?? 'unknown';

            // A preflight is a question about the origin, not about a route, and it is asked before
            // the request it is about — including for paths this relay does not serve, and for tags
            // it has never heard of. Answering it only on the routes that exist refuses the request
            // in the browser, so the client sees an opaque network failure where the truth was a
            // 404 or a 502, and a read that would have been retried on a real answer instead looks
            // like a dead channel.
            if (req.method === 'OPTIONS') {
                return new Response(null, { status: 204, headers: CORS });
            }

            if (url.pathname === '/health') {
                return json(200, { ok: true, daemons: daemons.size });
            }
            /**
             * The directory, as a plain resource.
             *
             * It is state, not an event: an idempotent read that a client may repeat whenever it
             * likes, whose unchanged answer costs a 304. The hub still pushes the directory to
             * clients that cannot ask, but a client that can is not made to receive it on the same
             * ordered connection its session streams ride — a snapshot queued there delays the
             * frames behind it, which is a delay a read would never impose.
             */
            if (url.pathname === '/machines') {
                if (limited(ip)) return json(429, { error: 'rate' });
                if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'method' });
                const snapshot = directorySnapshot();
                const headers = {
                    'content-type': 'application/json',
                    // Revalidated, not cached blindly: the etag is the one fact a client needs to
                    // skip a body it already has.
                    'cache-control': 'no-cache',
                    etag: snapshot.etag,
                    ...CORS,
                };
                if (req.headers.get('if-none-match') === snapshot.etag) {
                    return new Response(null, { status: 304, headers });
                }
                return new Response(req.method === 'HEAD' ? null : snapshot.body, { status: 200, headers });
            }
            if (url.pathname === '/client') {
                if (limited(ip)) return json(429, { error: 'rate' });
                const directory = url.searchParams.get('dir') === 'http' ? 'http' as const : undefined;
                const ok = srv.upgrade(req, { data: { kind: 'hub', ip, streams: new Map(), directory } as SocketData });
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
            // The path the caller actually used, before this relay stripped the `/r/<tag>` prefix.
            // A proof an older App signed covers that path — it cannot cover the stripped one, which
            // it never saw — and this relay is the only party that knows it. The daemon falls back to
            // it when the newer, path-independent proof does not verify.
            headers['x-happy-forwarded-path'] = new URL(req.url, 'http://relay.invalid').pathname;
            const id = daemon.nextId++;
            return new Promise<Response>((resolve) => {
                const timer = setTimeout(() => {
                    daemon.pending.delete(id);
                    resolve(json(504, { error: 'timeout' }));
                }, httpTimeout);
                daemon.pending.set(id, { resolve, timer, request: { tag, method: req.method, path: rest } });
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
                    const snapshot = directorySnapshot();
                    if (data.directory === 'http') {
                        // The etag is the whole handshake: the client fetches the directory over
                        // HTTP and needs neither a copy here nor a reason to fetch one it already
                        // has.
                        ws.send(JSON.stringify({ t: 'ok', etag: snapshot.etag }));
                    } else {
                        ws.send(JSON.stringify({ t: 'ok', machines: snapshot.machines, etag: snapshot.etag }));
                    }
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
                    const daemon: Daemon = { tag, ws, pending: new Map(), clients: new Map(), hub: new Map(), sessions: [], reachable: null, nextId: 1 };
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
                    logSessionRead(p.request, Number(msg.status) || 502, msg.body ? String(msg.body) : null);
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
                    // Narrowed on the way in: see `DirectorySession` for why the blobs stop here.
                    const published: unknown[] = Array.isArray(msg.sessions) ? msg.sessions : [];
                    daemon.sessions = published
                        .map(directorySession)
                        .filter((session): session is DirectorySession => session !== null);
                    broadcastDirectory();
                } else if (msg.t === 'reachable') {
                    // Same deal as the session list: the machine's own claim about itself, carried so
                    // a client can reach it without asking it. Sent on registration and whenever the
                    // machine's log records a new address.
                    daemon.reachable = msg.endpoints ? { endpoints: msg.endpoints, at: msg.at, rev: msg.rev } : null;
                    broadcastDirectory();
                }
            },
            close(ws) {
                const data = ws.data;
                if (data.kind === 'hub') {
                    hubClients.delete(ws);
                    // What was last sent is only a record of what *connected* clients already
                    // know. With none connected, the directory can move and move back; forgetting
                    // it means the next client's `ok` is the baseline, and no later change can be
                    // suppressed for matching a frame that client never saw.
                    if (hubClients.size === 0) lastDirectoryFrame = null;
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

    /**
     * What a client can reach: every daemon that is dialled in, with what it published — its
     * sessions, and where it says it can be reached.
     */
    function directory(): { tag: string; sessions: DirectorySession[]; reachable: unknown | null }[] {
        return [...daemons.values()].map((daemon) => ({ tag: daemon.tag, sessions: daemon.sessions, reachable: daemon.reachable }));
    }

    /**
     * The directory as one value: what it says, and the fingerprint that says whether it says the
     * same thing as before.
     *
     * HTTP and the hub serve the same value, so the etag is computed from the HTTP body and reused
     * on the hub. That is what lets a client that reads the directory over HTTP act on a nudge
     * without ever receiving a second copy of something it already has.
     */
    function directorySnapshot(): {
        machines: { tag: string; sessions: DirectorySession[]; reachable: unknown | null }[];
        body: string;
        etag: string;
    } {
        const machines = directory();
        const body = JSON.stringify({ machines });
        return { machines, body, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"` };
    }

    /**
     * Tells every hub client the directory changed.
     *
     * Pushed rather than left to be polled: a machine coming online is exactly the event an App
     * wants to hear about, and asking for it on a timer is the probing this connection exists to
     * replace.
     *
     * Coalesced and deduplicated, because the events are not edges. Every daemon re-reads its list
     * on a timer and publishes it whenever *anything* in it moved — a heartbeat, a version — so a
     * six-machine deployment can produce a burst of frames that all say the same thing to a client.
     * Sending each one would put that burst on the same connection a stream's handshake is waiting
     * on. One frame per burst, and only when an App could tell the difference, is the same
     * information without the queue.
     */
    function broadcastDirectory(): void {
        if (hubClients.size === 0 || directoryBroadcastTimer) return;
        directoryBroadcastTimer = setTimeout(() => {
            directoryBroadcastTimer = null;
            if (hubClients.size === 0) return;
            const snapshot = directorySnapshot();
            const frame = JSON.stringify({ t: 'machines', machines: snapshot.machines });
            if (frame === lastDirectoryFrame) return;
            lastDirectoryFrame = frame;
            for (const client of hubClients) {
                try {
                    // Two shapes of the same news. A client that reads the directory over HTTP is
                    // told only that it moved; one that cannot ask gets the directory itself. The
                    // state is the same either way, and neither client waits on the other's copy.
                    client.send(client.data?.directory === 'http'
                        ? JSON.stringify({ t: 'dir', etag: snapshot.etag })
                        : frame);
                } catch { /* gone */ }
            }
        }, DIRECTORY_BROADCAST_DELAY_MS);
        (directoryBroadcastTimer as unknown as { unref?: () => void }).unref?.();
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
            daemon.pending.set(daemonId, {
                timer,
                hub: { client: ws, clientId: frame.id },
                request: { tag: frame.tag, method: String(frame.method ?? 'GET'), path: frame.path },
            });
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
        stop: () => {
            clearInterval(sweep);
            if (directoryBroadcastTimer) {
                clearTimeout(directoryBroadcastTimer);
                directoryBroadcastTimer = null;
            }
            server.stop(true);
        },
        daemonCount: () => daemons.size,
    };
}
