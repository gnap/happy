/**
 * Keeps one outbound connection to a public relay and serves the local LAN API through it.
 *
 * The relay is only a pipe: every request it hands us is replayed against 127.0.0.1:<lanPort>, so
 * the LAN server's own challenge-response auth still decides who gets in. Nothing here widens what
 * the LAN API exposes -- it only changes how the bytes arrive.
 */
import { logger } from '@/ui/logger';
import { deriveRelayIdentity, signRegistration, type RelayIdentity } from './identity';

export type RelayClientOptions = {
  /** `wss://host[:port]` of the relay. */
  relayUrl: string;
  machineKey: Uint8Array;
  lanPort: number;
  /** Fired when registration succeeds / the connection drops. */
  onStatus?: (connected: boolean) => void;
  /**
   * What this daemon has, for the relay's directory.
   *
   * The relay answers "which machines, and what sessions" for every App that asks, the way the
   * server does — and it can only do that because each daemon publishes its own summary. It is the
   * same list the LAN API serves, so this says nothing the relay could not already fetch through
   * itself; publishing it is what saves every App a per-machine round trip and a per-machine socket.
   */
  getSessions?: () => unknown[];
  minBackoffMs?: number;
  maxBackoffMs?: number;
};

export type RelayClientHandle = {
  identity: RelayIdentity;
  isConnected: () => boolean;
  stop: () => void;
};

/** The relay closes a connection rather than deliver a frame larger than this. */
const RELAY_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * How often to check whether this daemon's session list changed.
 *
 * A poll rather than a hook into the session lifecycle: the list is already computed on demand for
 * the LAN API, comparing it costs one stringify, and a session appearing is not urgent enough to
 * justify threading a notification through every path that starts or ends one.
 */
const SESSIONS_PUBLISH_INTERVAL_MS = 5_000;
const STRIP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding']);
const STRIP_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection']);

export function startRelayClient(options: RelayClientOptions): RelayClientHandle {
  const identity = deriveRelayIdentity(options.machineKey);
  const minBackoff = options.minBackoffMs ?? 1_000;
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  const control = options.relayUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + '/daemon';
  let stopped = false;
  let connected = false;
  let socket: WebSocket | null = null;
  let backoff = minBackoff;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The summary last published, so an unchanged one is not re-sent every tick. */
  let publishedSessions: string | null = null;
  let sessionsTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * How to write to the *registered* connection, or null while there is none.
   *
   * Set once registration completes rather than captured per attempt: the session list is published
   * on a timer that outlives any one connection, and writing through a stale socket would report
   * success for a frame nobody received.
   */
  let publishFrame: ((frame: unknown) => void) | null = null;

  /** Sends the session list the relay publishes, if it is different from the last one. */
  const publishSessions = () => {
    const send = publishFrame;
    if (!send || stopped) return;
    let sessions: unknown[];
    try {
      sessions = options.getSessions?.() ?? [];
    } catch (error) {
      logger.debug(`[relay] could not read the session list: ${String(error)}`);
      return;
    }
    const encoded = JSON.stringify(sessions);
    if (encoded === publishedSessions) return;
    publishedSessions = encoded;
    try { send({ t: 'sessions', sessions }); } catch { /* the close handler reconnects */ }
  };

  const setConnected = (value: boolean) => {
    if (connected !== value) {
      connected = value;
      options.onStatus?.(value);
    }
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(control);
    socket = ws;
    const locals = new Map<number, { ws: WebSocket; queue: string[]; open: boolean }>();
    let opened = false;

    const send = (frame: unknown) => {
      try { ws.send(JSON.stringify(frame)); } catch { /* the close handler reconnects */ }
    };

    ws.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(String(event.data)); } catch { return; }

      if (msg.t === 'challenge') {
        send({ t: 'register', pub: Buffer.from(identity.publicKey).toString('base64'), sig: signRegistration(identity, msg.nonce) });
      } else if (msg.t === 'ok') {
        opened = true;
        backoff = minBackoff;
        setConnected(true);
        logger.debug(`[relay] registered as ${identity.tag} via ${control}`);
        // The directory the relay answers with is built from what daemons publish, so it is sent on
        // registration and again whenever it changes — a session starting or ending is exactly the
        // change an App wants to hear about.
        publishFrame = send;
        publishedSessions = null;
        publishSessions();
        if (sessionsTimer === null) {
          sessionsTimer = setInterval(publishSessions, SESSIONS_PUBLISH_INTERVAL_MS);
          (sessionsTimer as any).unref?.();
        }
      } else if (msg.t === 'http') {
        // The query is part of the picture for a history read: `since` is what says whether the
        // reader is taking pages or re-reading the log from the start every time. The client
        // address is what says *who*: every relayed request arrives from the relay's loopback, so
        // without the forwarded address a handshake storm from four devices is indistinguishable
        // from one device doing it four times as often.
        logger.debug(`[relay] http ${msg.method} ${msg.path} from=${msg.ip ?? '-'}`);
        void forwardHttp(msg, options.lanPort).then((res) => {
          if (res && typeof res === 'object' && 'status' in res && (res as { status: number }).status >= 400) {
            logger.debug(`[relay] http-res ${(res as { status: number }).status} ${msg.method} ${msg.path}`);
          }
          const size = JSON.stringify(res).length;
          // Mirrors the relay's maxFrameBytes. A larger frame does not fail cleanly: the relay's
          // runtime drops the whole connection, which reads as a phantom network fault and makes
          // every reader on it retry. Saying so here is what turns that into a diagnosable bug.
          if (size > RELAY_MAX_FRAME_BYTES) {
            logger.warn(`[relay] response too large for the relay: ${msg.method} ${msg.path} bytes=${size}`);
          }
          send(res);
        });
      } else if (msg.t === 'ws-open') {
        logger.debug(`[relay] ws-open ${String(msg.path).split('?')[0]} from=${msg.ip ?? '-'}`);
        const local = new WebSocket(`ws://127.0.0.1:${options.lanPort}${msg.path}`);
        const entry = { ws: local, queue: [] as string[], open: false };
        locals.set(msg.id, entry);
        local.onopen = () => {
          entry.open = true;
          for (const m of entry.queue) local.send(m);
          entry.queue = [];
        };
        local.onmessage = (e) => { if (typeof e.data === 'string') send({ t: 'ws-msg', id: msg.id, data: e.data }); };
        local.onclose = (e) => {
          if (locals.delete(msg.id)) send({ t: 'ws-close', id: msg.id, code: e.code, reason: e.reason });
        };
        local.onerror = () => { /* onclose follows */ };
      } else if (msg.t === 'ws-msg') {
        const entry = locals.get(msg.id);
        if (!entry) {
          logger.debug(`[relay] ws-msg for unknown socket ${String(msg.id)}, dropped`);
          return;
        }
        logger.debug(`[relay] ws-msg -> local socket ${String(msg.id)} bytes=${String(msg.data).length} open=${entry.open}`);
        if (entry.open) entry.ws.send(String(msg.data));
        else entry.queue.push(String(msg.data));
      } else if (msg.t === 'ws-close') {
        const entry = locals.get(msg.id);
        locals.delete(msg.id);
        try { entry?.ws.close(); } catch { /* gone */ }
      }
    };

    const onGone = (event: any) => {
      logger.debug(`[relay] control closed code=${event?.code} reason=${event?.reason ?? ''} opened=${opened} wasCurrent=${socket === ws}`);
      if (socket !== ws) return;
      socket = null;
      publishFrame = null;
      for (const entry of locals.values()) {
        try { entry.ws.close(); } catch { /* gone */ }
      }
      locals.clear();
      setConnected(false);
      if (stopped) return;
      const delay = opened ? minBackoff : backoff;
      backoff = Math.min(backoff * 2, maxBackoff);
      retryTimer = setTimeout(connect, delay);
      (retryTimer as any).unref?.();
    };
    ws.onclose = onGone;
    ws.onerror = () => { /* onclose follows */ };
  };

  connect();

  return {
    identity,
    isConnected: () => connected,
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (sessionsTimer) { clearInterval(sessionsTimer); sessionsTimer = null; }
      try { socket?.close(); } catch { /* gone */ }
      setConnected(false);
    },
  };
}

async function forwardHttp(msg: any, lanPort: number): Promise<unknown> {
  try {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.headers ?? {})) {
      if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
    }
    // The request is replayed from loopback, so without this the LAN server sees every relayed
    // client as 127.0.0.1 — and its per-address rate limits then share one bucket between every
    // device arriving through the relay, which is enough to lock a client out of its own daemon.
    if (msg.ip) {
      headers['x-happy-client-ip'] = String(msg.ip);
    }
    const res = await fetch(`http://127.0.0.1:${lanPort}${msg.path}`, {
      method: msg.method,
      headers,
      body: msg.body ? Buffer.from(String(msg.body), 'base64') : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => { if (!STRIP_RESPONSE_HEADERS.has(k)) out[k] = v; });
    return { t: 'http-res', id: msg.id, status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()).toString('base64') };
  } catch (error) {
    return { t: 'http-res', id: msg.id, status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: String(error) })).toString('base64') };
  }
}
