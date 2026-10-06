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
import { logger } from '@/ui/logger';

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

export type LanServerOptions = {
  /** The machine key: a 32-byte symmetric secret shared with the App via the machine record. */
  secret: Uint8Array;
  machineId: string;
  /** Stable non-secret fingerprint of the account, so a client can filter before probing. */
  accountFingerprint: string;
  getSessions: () => LanSessionSummary[];
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

export async function startLanServer(opts: LanServerOptions): Promise<LanServerHandle> {
  const app: FastifyInstance = fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });
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

    const record = nonces.get(nonce);
    // Consume the nonce regardless of the outcome: a nonce that survived a failed proof
    // would be a free retry oracle for an attacker guessing at the key.
    nonces.delete(nonce);
    if (!record || now - record.issuedAt > NONCE_TTL_MS || record.expiresAt <= now) {
      return reply.code(401).send({ error: 'invalid or expired nonce' });
    }

    const expected = hmac(opts.secret, `${PROOF_CONTEXT}.${nonce}`).toString('base64url');
    if (!safeEqual(Buffer.from(proof), Buffer.from(expected))) {
      // Never echo the proof or the secret into logs or the error body.
      return reply.code(401).send({ error: 'invalid proof' });
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
    stop: async () => {
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
