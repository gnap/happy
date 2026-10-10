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
      } else if (msg.t === 'http') {
        // The query is part of the picture for a history read: `since` is what says whether the
        // reader is taking pages or re-reading the log from the start every time.
        logger.debug(`[relay] http ${msg.method} ${msg.path}`);
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
        logger.debug(`[relay] ws-open ${String(msg.path).split('?')[0]}`);
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
