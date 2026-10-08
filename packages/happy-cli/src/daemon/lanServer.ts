/**
 * Read-only, authenticated LAN API.
 *
 * Lets a client on the same network read this machine's session list without going through
 * the Happy server. This is deliberately SEPARATE from the daemon's control server: that
 * one has no authentication at all and is protected only by being bound to loopback, and it
 * exposes mutation routes (`/spawn-session`, `/stop-session`, `/stop`). Nothing here
 * mutates anything, and the control server is untouched.
 *
 * Authentication is a challenge-response over the machine key — the 32-byte symmetric key
 * the CLI generated at auth time and wrapped into the machine record, which the App already
 * fetches and unwraps. So no new key distribution is needed, and the key never goes on the
 * wire: the client proves possession of it and receives a short-lived bearer token.
 *
 * Deliberately plain HTTP. The payload is read-only metadata and the token is short-lived;
 * the tradeoff is that a sniffer on the LAN can steal the token, which is why the TTL is
 * 90s rather than minutes. A client must be built with the platform's local-network
 * cleartext exception (iOS: NSAllowsLocalNetworking).
 *
 * The module takes its configuration as arguments and never reads `configuration`, so it
 * can be exercised directly against an ephemeral port in tests.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname, platform } from 'node:os';
import fastify, { type FastifyInstance } from 'fastify';
import websocket, { type WebSocket } from '@fastify/websocket';
import { logger } from '@/ui/logger';
import type { SessionLogEntry } from '@/api/sessionLog';

/** How long an issued bearer token stays valid. Short because it travels over cleartext. */
const TOKEN_TTL_MS = 90_000;
/** How long a challenge nonce may be redeemed after being issued. */
const NONCE_TTL_MS = 30_000;

/**
 * `/lan/challenge` is unauthenticated, so its store is a remote memory-exhaustion vector
 * unless bounded. The cap plus the per-IP limiter is the mitigation.
 */
const MAX_TRACKED_NONCES = 512;
const MAX_TRACKED_ADDRESSES = 256;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CHALLENGES_PER_WINDOW = 30;
const MAX_SESSION_ATTEMPTS_PER_WINDOW = 10;

/** Bodies here are a nonce and a proof; anything larger is abuse. */
const BODY_LIMIT_BYTES = 4096;

const PROOF_CONTEXT = 'v1.proof';
const TOKEN_CONTEXT = 'v1.token';

export const LAN_PROTOCOL_VERSION = 1;

export type LanSessionSummary = {
  happySessionId: string;
  directory: string;
  agent: string;
  startedBy: string;
  isAlive: boolean;
  lastHeartbeat?: number;
};

export type LanHistory = {
  tag: string;
  /**
   * base64 of `version(1) || box(contentKey -> account content public key)` — byte-for-byte
   * the same shape the server hands out as `Session.dataEncryptionKey`, so a client can reuse
   * its unwrapping code unchanged. The machine key plays no part in reading message content.
   */
  dataEncryptionKey: string;
  /** Ciphertext entries exactly as they crossed the wire — only those written after `since`. */
  entries: SessionLogEntry[];
  /**
   * Opaque position to pass back as `?since=` for the next read. Without it a polling client
   * re-fetches and re-decrypts the entire log on every tick, which is the difference between a
   * fallback that is merely slower than the server and one that is unusable.
   */
  cursor: string;
  /** True when `since` could not be honoured, so `entries` is the whole log, not a continuation. */
  reset: boolean;
};

export type LanServerOptions = {
  /** The machine key: a 32-byte symmetric secret shared with the App via the machine record. */
  secret: Uint8Array;
  machineId: string;
  /** Stable non-secret fingerprint of the account, so a client can filter before probing. */
  accountFingerprint: string;
  getSessions: () => LanSessionSummary[];
  /**
   * Local history for a session, or null when this machine has none — the session may not
   * have reported its tag yet, or its key may be gone. Injected so this module keeps knowing
   * nothing about configuration or the filesystem.
   */
  getHistory: (sessionId: string, since?: string) => LanHistory | null;
  /**
   * A user message the App sent over the LAN socket. `content` is the same ciphertext the server
   * route carries, so this stays end-to-end encrypted — the LAN is plain HTTP, which is exactly
   * why the payload must not be readable here.
   */
  onSend: (message: { sessionId: string; localId: string; content: string }) => void;
  /** Defaults to all interfaces. See the binding caveat in the module docs. */
  host?: string;
  /** Defaults to 0 — the OS assigns one, and mDNS advertises it. */
  port?: number;
  /**
   * Overrides for the anti-abuse bounds. Present so the bounded nonce store can actually be
   * proven in a test — at production values the per-IP limiter fires long before the count
   * cap is reached, so the cap would otherwise be untestable. Production never sets this.
   */
  limits?: Partial<{
    maxTrackedNonces: number;
    maxChallengesPerWindow: number;
    maxSessionAttemptsPerWindow: number;
  }>;
};

export type LanServerHandle = {
  port: number;
  /**
   * Pushes one named event to every live socket reader. The daemon calls this with the same
   * envelope shape the server's socket uses, which is what makes the LAN channel transparent to
   * the App's existing update handler.
   */
  broadcast: (event: string, payload: unknown) => void;
  stop: () => Promise<void>;
};

type NonceRecord = { issuedAt: number; expiresAt: number };
type RateRecord = { count: number; windowStart: number };

function hmac(secret: Uint8Array, message: string): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The App reaches this API from a webview on desktop, and a webview enforces CORS where the
 * native fetch on iOS/Android does not. Without these headers the browser discards every
 * response, so the session reads fail with an opaque "Load failed" — the LAN channel looks
 * completely dead on desktop while working fine on a phone.
 *
 * Origin is `*` deliberately. The caller's origin differs per build (the Metro dev server on
 * localhost, `tauri://localhost` once packaged), and an allowlist that misses one reinstates
 * exactly that silent failure. It is affordable here because nothing is cookie-authenticated:
 * every route but `/lan/challenge` requires a bearer token the caller can only obtain by proving
 * possession of the machine key, so a wildcard grants no ambient authority. A hostile page can
 * reach the challenge route and learn that a daemon is present; it cannot mint a token, and the
 * nonce it receives is useless without the key.
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
};

export async function startLanServer(opts: LanServerOptions): Promise<LanServerHandle> {
  const app: FastifyInstance = fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  await app.register(websocket);

  /**
   * Live LAN readers.
   *
   * The socket is the point of the whole exercise: a reader that holds one open no longer polls,
   * so a message reaches it when it is written rather than up to an interval later. It is also
   * why the bearer token could go — a socket authenticates once at the upgrade and then *is* the
   * authenticated channel, so there is no short-lived credential to sniff or expire.
   */
  const subscribers = new Set<WebSocket>();

  /**
   * Pushes one event to every live reader, in the same envelope shape the server's socket uses.
   * Named `event`/`payload` because a raw socket has no event names of its own, and the names are
   * what let the App route this to the same handler the server channel feeds.
   */
  const broadcast = (event: string, payload: unknown): void => {
    if (subscribers.size === 0) {
      return;
    }
    const frame = JSON.stringify({ event, payload });
    for (const socket of subscribers) {
      // 1 = OPEN. A socket mid-close is skipped rather than throwing out of the daemon's
      // session-event handler, which is on a session's forwarding path.
      if (socket.readyState === 1) {
        socket.send(frame);
      }
    }
  };

  app.addHook('onRequest', async (request, reply) => {
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      reply.header(name, value);
    }
    if (request.method === 'OPTIONS') {
      // Fastify has no OPTIONS route, so without this the preflight gets a 404 and the browser
      // never sends the request it was asking about — a JSON POST always preflights.
      return reply.code(204).send();
    }
  });
  const MAX_NONCES = opts.limits?.maxTrackedNonces ?? MAX_TRACKED_NONCES;
  const MAX_CHALLENGES = opts.limits?.maxChallengesPerWindow ?? MAX_CHALLENGES_PER_WINDOW;
  const MAX_SESSION_ATTEMPTS = opts.limits?.maxSessionAttemptsPerWindow ?? MAX_SESSION_ATTEMPTS_PER_WINDOW;

  // nonce -> its windows. Insertion-ordered, so eviction drops the oldest first.
  const nonces = new Map<string, NonceRecord>();
  const challenges = new Map<string, RateRecord>();
  const sessionAttempts = new Map<string, RateRecord>();

  const pruneNonces = (now: number) => {
    for (const [nonce, record] of nonces) {
      if (record.expiresAt <= now) {
        nonces.delete(nonce);
      }
    }
  };

  /** Fixed-window limiter, itself bounded so it cannot become the memory-exhaustion vector. */
  const underLimit = (store: Map<string, RateRecord>, address: string, max: number, now: number): boolean => {
    const record = store.get(address);
    if (!record || now - record.windowStart >= RATE_LIMIT_WINDOW_MS) {
      if (store.size >= MAX_TRACKED_ADDRESSES) {
        const oldest = store.keys().next();
        if (!oldest.done) {
          store.delete(oldest.value);
        }
      }
      store.set(address, { count: 1, windowStart: now });
      return true;
    }
    record.count += 1;
    return record.count <= max;
  };

  const issueToken = (nonce: string, expiresAt: number): string => {
    const payload = `${nonce}.${expiresAt}`;
    const mac = hmac(opts.secret, `${TOKEN_CONTEXT}.${payload}`).toString('base64url');
    return Buffer.from(`${payload}.${mac}`).toString('base64url');
  };

  const verifyToken = (token: string, now: number): boolean => {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 3) {
      return false;
    }
    const [nonce, expiresAtRaw, mac] = parts;
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return false;
    }
    const expected = hmac(opts.secret, `${TOKEN_CONTEXT}.${nonce}.${expiresAt}`).toString('base64url');
    if (!safeEqual(Buffer.from(mac), Buffer.from(expected))) {
      return false;
    }
    // The nonce must still be on record: it is what makes a token single-issued, and it
    // bounds token lifetime to the store's retention even if the payload claims longer.
    const record = nonces.get(nonce);
    return record !== undefined && record.expiresAt > now;
  };

  const requireToken = (request: { headers: Record<string, unknown> }): boolean => {
    const header = request.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return false;
    }
    return verifyToken(header.slice('Bearer '.length), Date.now());
  };

  /**
   * The nonce record when `proof` verifies against it, else null. Does not consume the nonce —
   * callers decide that, because the two callers want different things: the token exchange keeps
   * the nonce so the token stays bound to it, while a socket upgrade spends it outright.
   */
  const verifiedNonce = (nonce: string | null, proof: string | null, now: number): NonceRecord | null => {
    if (!nonce || !proof) {
      return null;
    }
    const record = nonces.get(nonce);
    if (!record || now - record.issuedAt > NONCE_TTL_MS || record.expiresAt <= now) {
      return null;
    }
    const expected = hmac(opts.secret, `${PROOF_CONTEXT}.${nonce}`).toString('base64url');
    return safeEqual(Buffer.from(proof), Buffer.from(expected)) ? record : null;
  };

  app.post('/lan/challenge', async (request, reply) => {
    const now = Date.now();
    if (!underLimit(challenges, request.ip, MAX_CHALLENGES, now)) {
      return reply.code(429).send({ error: 'too many requests' });
    }
    pruneNonces(now);
    if (nonces.size >= MAX_NONCES) {
      const oldest = nonces.keys().next();
      if (!oldest.done) {
        nonces.delete(oldest.value);
      }
    }
    const nonce = randomBytes(32).toString('base64url');
    nonces.set(nonce, { issuedAt: now, expiresAt: now + TOKEN_TTL_MS });
    return reply.send({ nonce });
  });

  app.post('/lan/session', async (request, reply) => {
    const now = Date.now();
    if (!underLimit(sessionAttempts, request.ip, MAX_SESSION_ATTEMPTS, now)) {
      return reply.code(429).send({ error: 'too many requests' });
    }
    const body = request.body as { nonce?: unknown; proof?: unknown } | undefined;
    const nonce = typeof body?.nonce === 'string' ? body.nonce : null;
    const proof = typeof body?.proof === 'string' ? body.proof : null;
    if (!nonce || !proof) {
      return reply.code(400).send({ error: 'nonce and proof required' });
    }

    const record = verifiedNonce(nonce, proof, now);
    // Consume the nonce regardless of the outcome: a nonce that survived a failed proof
    // would be a free retry oracle for an attacker guessing at the key.
    nonces.delete(nonce);
    if (!record) {
      // Never echo the proof or the secret into logs or the error body.
      return reply.code(401).send({ error: 'invalid or expired nonce' });
    }

    nonces.set(nonce, record);
    return reply.send({ token: issueToken(nonce, record.expiresAt), expiresAt: record.expiresAt });
  });

  app.get('/lan/identity', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.send({
      v: LAN_PROTOCOL_VERSION,
      machineId: opts.machineId,
      accountFingerprint: opts.accountFingerprint,
      hostname: hostname(),
      platform: platform(),
    });
  });

  app.get('/lan/sessions', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.send({ sessions: opts.getSessions() });
  });

  app.get('/lan/sessions/:sessionId/history', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { sessionId } = request.params as { sessionId: string };
    const { since } = request.query as { since?: string };
    const history = opts.getHistory(sessionId, since);
    if (!history) {
      // 404 rather than an empty list: the client should retry later, not record "no history".
      return reply.code(404).send({ error: 'no local history for that session' });
    }
    return reply.send({ v: LAN_PROTOCOL_VERSION, ...history });
  });

  /**
   * The live channel. Authenticated at the upgrade with the same challenge proof the read routes
   * use, then spent: no token is minted, so there is nothing short-lived to leak or expire.
   */
  app.get('/lan/socket', { websocket: true }, (socket, request) => {
    const { nonce, proof } = request.query as { nonce?: string; proof?: string };
    const now = Date.now();
    const record = verifiedNonce(nonce ?? null, proof ?? null, now);
    // Spent either way, so a failed attempt cannot be retried against the same nonce.
    if (nonce) {
      nonces.delete(nonce);
    }
    if (!record) {
      socket.close(4401, 'unauthorized');
      return;
    }

    subscribers.add(socket);
    logger.debug('[lan] socket reader connected', { readers: subscribers.size });
    socket.on('close', () => {
      subscribers.delete(socket);
    });

    /**
     * Writing back over the same socket, rather than a new HTTP route.
     *
     * The socket is already authenticated, so a send needs no credential of its own — no token to
     * mint, and no second way to prove the same thing. It also collapses what would otherwise be a
     * second round trip into the channel the App already holds open.
     *
     * This does make the socket a write surface, which the read-only LAN API deliberately was not.
     * What keeps it bounded: the caller has already proved possession of the machine key, and all
     * it can do with that is hand a user message to a session — the same thing it could do through
     * the server. There is no spawn, stop, or shutdown route here, and none is implied.
     */
    socket.on('message', (raw: unknown) => {
      // `ws` hands a text frame over as a Buffer, not a string, so coercing here rather than
      // type-checking for a string: testing for one silently dropped every frame.
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : typeof raw === 'string'
            ? raw
            : null;
      if (text === null) {
        return;
      }
      let frame: { event?: unknown; payload?: unknown };
      try {
        frame = JSON.parse(text) as { event?: unknown; payload?: unknown };
      } catch {
        return;
      }
      if (frame.event !== 'send' || typeof frame.payload !== 'object' || frame.payload === null) {
        return;
      }
      const { sessionId, localId, content } = frame.payload as Record<string, unknown>;
      if (typeof sessionId !== 'string' || typeof localId !== 'string' || typeof content !== 'string') {
        return;
      }
      opts.onSend({ sessionId, localId, content });
    });
    socket.on('error', () => socket.close());
  });

  // Resolve/reject explicitly. The control server's `listen` callback throws inside an async
  // callback, which becomes an unhandled rejection and leaves its promise unsettled forever;
  // a LAN bind failure must instead surface to the caller, which degrades gracefully.
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      app.listen({ port, host: opts.host ?? '0.0.0.0' }, (err) => (err ? reject(err) : resolve()));
    });

  const preferredPort = opts.port ?? 0;
  try {
    await listen(preferredPort);
  } catch (error) {
    // A preferred port keeps a published endpoint valid across daemon restarts, but losing
    // the feature to a port conflict would be worse than losing that stability.
    if (preferredPort === 0 || (error as { code?: string })?.code !== 'EADDRINUSE') {
      throw error;
    }
    logger.warn('[lan] preferred port is in use; falling back to an ephemeral one', { port: preferredPort });
    await listen(0);
  }

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 0);
  logger.debug(`[lan] serving read-only API on ${opts.host ?? '0.0.0.0'}:${port}`);

  return {
    port,
    broadcast,
    stop: async () => {
      // Close readers first: `app.close()` waits for open connections, and a subscriber that
      // never reconnects would hold the port open past the daemon's shutdown.
      for (const socket of subscribers) {
        socket.close(1001, 'daemon shutting down');
      }
      subscribers.clear();
      await app.close();
    },
  };
}

/** Non-secret, stable fingerprint of the account, published in mDNS so clients can filter. */
export function accountFingerprintOf(accountPublicKey: Uint8Array): string {
  return createHmac('sha256', 'happy-lan-account-fingerprint').update(accountPublicKey).digest('hex').slice(0, 16);
}

/** Client-side helper: the proof a LAN client must return for a challenge nonce. */
export function lanProofFor(secret: Uint8Array, nonce: string): string {
  return hmac(secret, `${PROOF_CONTEXT}.${nonce}`).toString('base64url');
}
