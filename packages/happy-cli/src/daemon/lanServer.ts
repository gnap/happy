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
  /**
   * The id the server issued. Absent while the session is still waiting for the server — which
   * is precisely when a reader most needs to see it, so this is not the field to key on.
   */
  happySessionId?: string;
  /**
   * The tag the CLI owns: set at spawn, so a session whose server id does not exist yet is still
   * nameable, and `/lan/tags/:tag/history` can serve it. A session with neither is not listed at
   * all — there would be no way for a reader to ask for it.
   */
  tag?: string;
  directory: string;
  agent: string;
  startedBy: string;
  isAlive: boolean;
  lastHeartbeat?: number;
  /**
   * The session's own metadata, in the two pieces the reader needs to open it: the revision the
   * ciphertext was sealed at, and the ciphertext — `Session.metadataVersion` and
   * `Session.metadata`, under those names, because the reader already holds the code for them.
   *
   * A reader that can open it — the App holds the account key — can therefore read what the session
   * says about itself without the server: its CLI version above all, which is a build id and changes
   * with every build, so a reader that cannot refresh it shows whichever version it last heard and
   * reports a mismatch it has no way to confirm or clear.
   */
  metadataVersion?: number;
  metadata?: string;
  /**
   * The session key that opens `metadata` (and the message log), wrapped to the account's box
   * public key — the same shape `/history` returns as `dataEncryptionKey`, version byte 0 first.
   *
   * The list needs the name before it needs messages, and a reader that has never seen this
   * session has no key. Carrying it here is what lets the App render a full row from the roster
   * instead of waiting for the server's session record.
   */
  dataEncryptionKey?: string;
  /**
   * When this daemon began restarting the session, if it is restarting it.
   *
   * A timestamp rather than a flag, and for the same reason the daemon's published state carries
   * one: a reader applies a grace to it, so an entry that outlived the restart it described goes
   * stale on its own. Without it, a restart reads as a session that has ended — which is what it
   * looks like from anywhere else, because nothing reports the session while it happens.
   */
  restartingSince?: number;
};

/** How a reader names a session: by the id the server issued, or by the tag the CLI owns. */
export type LanSessionAddress = { sessionId: string } | { tag: string };

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
  /**
   * Boundary before the first entry, to hand back as `before` for the next older page. Every page
   * carries both of its edges, so a reader can walk the log in either direction.
   */
  older: string;
  /** The log continues past this page, which is what tells a reader its page was cut short. */
  hasNewer: boolean;
  /** The log continues before this page, which is the whole "there is older history" signal. */
  hasOlder: boolean;
};

import type { VersionState } from './versionState';
import { accountProofMessage, accountProofMessageV1, verifyAccountProof } from './accountProof';

export type LanServerOptions = {
  /** The machine key: a 32-byte symmetric secret shared with the App via the machine record. */
  secret: Uint8Array;
  machineId: string;
  /** Stable non-secret fingerprint of the account, so a client can filter before probing. */
  accountFingerprint: string;
  getSessions: () => LanSessionSummary[];
  /**
   * What this machine is running against what it has on disk.
   *
   * Asked per request rather than captured at startup, because the answer changes while the daemon
   * runs — that is the whole point of it.
   */
  versionState?: () => VersionState;
  /**
   * Local history for a session, or null when this machine has none — the session may not
   * have reported its tag yet, or its key may be gone. Injected so this module keeps knowing
   * nothing about configuration or the filesystem.
   *
   * Two addresses, because they become available at different times: the server issues the id,
   * the CLI owns the tag. A client that knows only the tag can still read, which is what keeps
   * a session reachable while it is waiting for the server.
   */
  getHistory: (address: LanSessionAddress, query: { since?: string; before?: string }) => LanHistory | null;
  /**
   * The full input and result of one tool call, for a detail view that was opened.
   *
   * The message stream carries a truncated copy — that is what keeps a session's log, its pages and
   * its relay traffic small — and the full payload stays in the session's own directory beside the
   * working tree. Null when this machine has no such session, or no such call on disk.
   */
  getToolContent?: (args: { sessionId: string; callId: string }) => Promise<{ args?: unknown; result?: unknown } | null> | { args?: unknown; result?: unknown } | null;
  /**
   * A user message the App sent over the LAN socket. `content` is the same ciphertext the server
   * route carries, so this stays end-to-end encrypted — the LAN is plain HTTP, which is exactly
   * why the payload must not be readable here.
   */
  onSend: (message: { sessionId: string; localId: string; content: string }) => void;
  /**
   * Restart the session process, with the build now on disk.
   *
   * The one write this API offers that is not a message. It is here because the reason a session
   * is restarted is that its machine has been rebuilt — and the machine's own channel is the one
   * that is up when that is true, while the server's is not necessarily. Without it the App could
   * only ask the server to do it, so a restart failed with "socket disconnected" while the machine
   * sat there answering reads on the LAN.
   *
   * Session-scoped, like the control server's own handler: it starts one session's process again
   * and touches nothing else on the machine. Absent means this daemon does not offer it, and a
   * caller falls back to whatever route it has left.
   */
  restartSession?: (sessionId: string) => Promise<{ success: boolean; newSessionId?: string; error?: string }>;
  /**
   * A control call the *session* acts on, forwarded to its process: abort the turn in flight, or
   * answer a permission request it is waiting on.
   *
   * The parameters travel as the same ciphertext the server route carries — the session's own key
   * is what opens them, and this side never holds it — so what the daemon needs from the caller is
   * only which session and which method. `params` is opaque here and stays opaque.
   *
   * Returns false when this machine has no live session by that id, which is the one thing the
   * caller has to be told: it is the difference between "the session acted" and "nobody was asked".
   */
  onSessionControl?: (request: { sessionId: string; method: string; params: string }) => boolean;
  /**
   * Checking that a side-effecting request was made by the account, not merely by a device holding
   * the machine key.
   *
   * The machine key is a transport credential every paired device holds, so without this "can
   * reach the daemon" and "may act on it" would be the same thing — and a key holder can derive the
   * relay tag, so per-channel rules would not help. One check on the route, both channels through
   * it. The material is already here: the account's public key is what the account fingerprint is
   * derived from.
   */
  accountProof?: {
    /** Verifies a detached signature over `accountProofMessage(...)`. */
    verify: (message: string, signature: string) => boolean;
    /** One-shot nonces: a signature that arrives twice is refused the second time. */
    nonceSeen: (nonce: string) => boolean;
    /** Called once a proof has been accepted, so the nonce cannot be used again. */
    rememberNonce: (nonce: string) => void;
  };
  /**
   * This machine's lifecycle log: which sessions it has started and archived, in order.
   *
   * A reader replays it at its own pace — that is what the cursor is for — so the App can be told
   * about a session this machine has, while the server catching up remains a separate progress.
   * Read on demand rather than pushed: the log is small, sessions change rarely, and a reader that
   * has been away asks for everything it missed in one request.
   */
  lifecycle?: {
    /** Where a reader stands after applying everything. */
    revision: () => number;
    entriesSince: (since: number) => unknown[];
  };
  /**
   * Update envelopes to send to a socket reader as soon as it connects, before any live frame.
   * A reader that joins after a session changed its state would otherwise never see that change:
   * the live mirror only carries what happens while it is listening.
   */
  getSnapshot?: () => unknown[];
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
 * every route but `/lan/challenge` and `/lan/ping` requires a bearer token the caller can only
 * obtain by proving possession of the machine key, so a wildcard grants no ambient authority. A
 * hostile page can reach the challenge route and learn that a daemon is present; it cannot mint a
 * token, and the nonce it receives is useless without the key.
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
  /**
   * The address to count this request against.
   *
   * A relayed request arrives from loopback with the client's own address in a header, because the
   * relay is the only thing on loopback: taking the header from anyone else would let a LAN client
   * pick its own bucket, and taking loopback at face value would put every relayed client in one.
   */
  const clientAddress = (request: { ip?: string; headers: Record<string, unknown> }): string => {
    const peer = request.ip ?? 'unknown';
    const forwarded = request.headers['x-happy-client-ip'];
    if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') {
      return typeof forwarded === 'string' && forwarded.length > 0 ? forwarded : peer;
    }
    return peer;
  };

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

  /**
   * Whether this request carries a usable token, saying so in the log when it does not.
   *
   * A direct LAN request that is refused is otherwise completely invisible: the relay's own logging
   * covers what arrives *through* the relay, so a client on the same network that is re-handshaking
   * every few seconds looks, from this daemon's log, exactly like a client that is doing nothing.
   * The address is what makes a storm attributable to one device.
   */
  const requireToken = (request: { headers: Record<string, unknown>; ip?: string; url?: string }): boolean => {
    const header = request.headers['authorization'];
    const ok =
      typeof header === 'string' && header.startsWith('Bearer ') && verifyToken(header.slice('Bearer '.length), Date.now());
    if (!ok) {
      logger.debug(`[lan] refused ${request.url ?? '-'} from=${clientAddress(request)}`);
    }
    return ok;
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

  /**
   * Whether this daemon is answering on this route — and nothing else.
   *
   * A client that holds no key can only prove reachability by asking for something, and the only
   * unauthenticated route used to be `/lan/challenge`. That made a pure reachability question cost
   * a minted nonce: a credential issued and thrown away, counted against the very rate limit that
   * exists to bound challenge floods, and retained in the nonce store until it expires. Answering
   * this costs nothing and allocates nothing, so a periodic probe is free.
   */
  app.get('/lan/ping', async (_request, reply) => reply.send({ ok: true, v: LAN_PROTOCOL_VERSION }));

  app.post('/lan/challenge', async (request, reply) => {
    const now = Date.now();
    if (!underLimit(challenges, clientAddress(request), MAX_CHALLENGES, now)) {
      logger.debug(`[lan] challenge refused (rate) from=${clientAddress(request)}`);
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
    // Logged because the challenge count is the whole question when a device is re-authenticating
    // more often than a 90-second token should require — and this route is unauthenticated, so the
    // address is the only thing that says which device it is.
    logger.debug(`[lan] challenge issued from=${clientAddress(request)}`);
    return reply.send({ nonce });
  });

  app.post('/lan/session', async (request, reply) => {
    const now = Date.now();
    if (!underLimit(sessionAttempts, clientAddress(request), MAX_SESSION_ATTEMPTS, now)) {
      logger.debug(`[lan] session refused (rate) from=${clientAddress(request)}`);
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
      logger.debug(`[lan] proof rejected from=${clientAddress(request)}`);
      return reply.code(401).send({ error: 'invalid or expired nonce' });
    }

    nonces.set(nonce, record);
    // The token exchange, logged with the address: pairing this against `challenge issued` is what
    // separates "handshaking too often" from "minting nonces nobody redeems".
    logger.debug(`[lan] session issued from=${clientAddress(request)}`);
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
      // Which build this machine is running, and whether the one on disk is a different one.
      versions: opts.versionState?.(),
    });
  });

  /**
   * The lifecycle log, from a reader's cursor.
   *
   * A route of its own rather than a field on `/lan/sessions`, because the two are different kinds
   * of thing and neither may pretend to be the other: the summary is a *snapshot* — what exists now
   * — and this is an ordered list of facts. A reader that wants to know what changed asks here; one
   * that wants to know what there is asks there.
   */
  app.get('/lan/lifecycle', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!opts.lifecycle) {
      return reply.code(404).send({ error: 'this daemon keeps no lifecycle log' });
    }
    const { since } = request.query as { since?: string };
    const cursor = Number.parseInt(since ?? '0', 10);
    const from = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
    const entries = opts.lifecycle.entriesSince(from);
    logger.debug(`[lan] lifecycle since=${from} entries=${entries.length} revision=${opts.lifecycle.revision()} from=${clientAddress(request)}`);
    return reply.send({ v: LAN_PROTOCOL_VERSION, revision: opts.lifecycle.revision(), entries });
  });

  app.get('/lan/sessions', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.send({ sessions: opts.getSessions() });
  });

  /**
   * The same history, addressed by the tag the CLI owns rather than the id the server issued.
   *
   * This is what keeps a session reachable while it is waiting out a server stall: it has a tag
   * from the moment it starts, but no session id until the server answers, and a reader that
   * cannot name it cannot reach it at all.
   */
  app.get('/lan/tags/:tag/history', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { tag } = request.params as { tag: string };
    const { since, before } = request.query as { since?: string; before?: string };
    const history = opts.getHistory({ tag }, { since, before });
    if (!history) {
      logger.debug(`[lan] history 404 tag=${tag} since=${since ?? '-'} before=${before ?? '-'}`);
      return reply.code(404).send({ error: 'no local history for that tag' });
    }
    logger.debug(
      `[lan] history tag=${tag} since=${since ?? '-'} before=${before ?? '-'} ` +
      `entries=${history.entries.length} hasNewer=${history.hasNewer} hasOlder=${history.hasOlder} reset=${history.reset}`,
    );
    return reply.send({ v: LAN_PROTOCOL_VERSION, ...history });
  });

  /**
   * Restart the session process on this machine.
   *
   * A POST because it changes something, and session-scoped because that is as far as it reaches:
   * no daemon stop, no shutdown, nothing about any other session. What it can do is bounded by what
   * the caller already holds — the machine key, which is only ever handed to a device the user
   * paired — and by the daemon refusing anything it would refuse the server route.
   *
   * Always 200 when this daemon offers the route at all, including a refusal, so the caller can
   * tell "this machine says no" from "this machine cannot be asked": the second is what sends it
   * to the server instead, and a refusal must not read as a reason to ask someone else.
   */
  app.post('/lan/sessions/:sessionId/restart', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { sessionId } = request.params as { sessionId: string };
    // The account has to sign for it. The machine key is a transport credential every paired device
    // holds, so without this "can connect" and "may restart a process" would be the same right.
    // This was off while the App signed with the wrong key (ed25519 signatures checked against the
    // curve25519 box key); the App now carries the account's signing key and the daemon verifies
    // with it, which is what tool-content has been doing all along.
    if (!requireAccountProof(request, { operation: 'restart', target: sessionId })) {
      return reply.code(403).send({ error: 'account proof required' });
    }
    if (!opts.restartSession) {
      return reply.code(404).send({ error: 'this daemon does not restart sessions' });
    }
    logger.debug(`[lan] restart ${sessionId} from=${clientAddress(request)}`);
    const result = await opts.restartSession(sessionId);
    logger.debug(`[lan] restart ${sessionId} success=${result.success}${result.error ? ` error=${result.error}` : ''}`);
    return reply.send({ v: LAN_PROTOCOL_VERSION, ...result });
  });

  /**
   * Control calls that act inside a session that already exists.
   *
   * Deliberately one route with the methods named here rather than one route per operation: what
   * this surface may do is then a list somebody can read, and the list is the point — the daemon's
   * own API starts sessions, stops them and runs things inside them, and none of that is reachable
   * from here. Aborting a turn and answering a prompt are the two that only move a session along
   * that is already running, which is the same boundary a restart sits on.
   */
  const SESSION_CONTROL_METHODS = new Set(['abort', 'permission']);
  /**
   * Whether this request carries the account's proof, and consumes its nonce when it does.
   *
   * Refused rather than allowed when the daemon has no way to check: a machine that cannot verify
   * cannot tell an account from a device holding the machine key, and guessing "allowed" would make
   * this decoration.
   */
  const requireAccountProof = (
    request: { headers: Record<string, unknown>; method?: string; url?: string },
    /** What the proof is about: the action, and what it is being asked of. */
    action: { operation: string; target: string },
  ): boolean => {
    if (!opts.accountProof) {
      // A warning, not a debug line: this daemon cannot authorise the action at all, and nothing
      // else about the request will say so — the caller sees a refusal it cannot explain.
      logger.warn(`[lan] refused ${request.url ?? '-'}: no account-proof check configured`);
      return false;
    }
    const header = (name: string): string | null => {
      const value = request.headers[name];
      return typeof value === 'string' && value.length > 0 ? value : null;
    };
    const nonce = header('x-happy-proof-nonce');
    const at = Number.parseInt(header('x-happy-proof-at') ?? '', 10);
    const signature = header('x-happy-proof-signature');
    const path = (request.url ?? '').split('?')[0];
    // What the client signed, when it arrived through the relay: the relay is the only party that
    // knows the path as the caller wrote it, since it is the one that strips the `/r/<tag>` prefix
    // before the request gets here. An older App signs that path (v1), so it is the only string its
    // proof can be checked against — and without this, every signed request through the relay failed
    // while the same request over the LAN worked.
    const forwarded = typeof request.headers['x-happy-forwarded-path'] === 'string'
      ? String(request.headers['x-happy-forwarded-path']).split('?')[0]
      : null;
    // Built as values rather than inline, so a refusal can print exactly what was checked against
    // what was received: an Ed25519 signature says nothing about the key that made it, so the
    // message bytes are the only thing a `bad-signature` can be diagnosed from.
    const messageV2 = accountProofMessage({
      operation: action.operation,
      target: action.target,
      nonce: nonce ?? '',
      at: Number.isFinite(at) ? at : 0,
      bodyDigest: '',
    });
    const messageV1 = accountProofMessageV1({
      method: request.method ?? 'POST',
      // `path`, not `forwarded`: the App signs the path it asks for — `/lan/sessions/<id>/control` —
      // which is exactly what this daemon sees, because the relay stripped its `/r/<tag>` prefix
      // before forwarding. Using the caller's prefixed path here was backwards and made every
      // relayed proof fail while the LAN ones passed.
      path,
      nonce: nonce ?? '',
      at: Number.isFinite(at) ? at : 0,
      bodyDigest: '',
    });
    const verdict = verifyAccountProof({
      proof: nonce !== null && Number.isFinite(at) && signature !== null ? { nonce, at, signature } : null,
      message: messageV2,
      legacyMessage: messageV1,
      nonceSeen: opts.accountProof.nonceSeen,
      verify: opts.accountProof.verify,
    });
    if (!verdict.ok) {
      // A warning for the same reason, and one more: the reason (missing, stale, replayed, bad
      // signature) is the whole diagnosis of a refusal a client can only see as a refusal. The two
      // paths are logged together because a v1 proof covers the path the *client* wrote, which is
      // not the one this daemon sees when the request came through the relay — and when the fallback
      // fails, those two strings are the whole answer.
      logger.warn([
        `[lan] refused ${request.url ?? '-'}: account proof ${verdict.reason}`,
        `from=${clientAddress(request)}`,
        `path=${path}`,
        `forwarded=${forwarded ?? '-'}`,
        `action=${action.operation}:${action.target}`,
        `nonce=${nonce ?? '-'}`,
        `at=${Number.isFinite(at) ? at : 0}`,
        `sig=${signature ? `${signature.slice(0, 12)}…(${signature.length})` : '-'}`,
        `v2=${JSON.stringify(messageV2)}`,
        `v1=${JSON.stringify(messageV1)}`,
      ].join(' '));
      return false;
    }
    opts.accountProof.rememberNonce(nonce!);
    return true;
  };

  app.post('/lan/sessions/:sessionId/control', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!opts.onSessionControl) {
      return reply.code(404).send({ error: 'this daemon does not forward session control' });
    }
    const { sessionId } = request.params as { sessionId: string };
    // Account-signed, for the same reason as restart: answering a permission or aborting a turn is
    // an action inside somebody's session, not a read of it.
    if (!requireAccountProof(request, { operation: 'control', target: sessionId })) {
      return reply.code(403).send({ error: 'account proof required' });
    }
    const body = request.body as { method?: unknown; params?: unknown } | null;
    const method = typeof body?.method === 'string' ? body.method : null;
    if (method === null || !SESSION_CONTROL_METHODS.has(method)) {
      logger.debug(`[lan] control refused: method=${String(body?.method)}`);
      return reply.code(400).send({ error: 'that is not a control this API forwards' });
    }
    if (typeof body?.params !== 'string') {
      return reply.code(400).send({ error: 'params must be the ciphertext the session can open' });
    }
    const delivered = opts.onSessionControl({ sessionId, method, params: body.params });
    logger.debug(`[lan] control ${method} ${sessionId} from=${clientAddress(request)} delivered=${delivered}`);
    if (!delivered) {
      return reply.code(404).send({ error: 'no live session by that id on this machine' });
    }
    return reply.send({ v: LAN_PROTOCOL_VERSION });
  });

  app.get('/lan/sessions/:sessionId/history', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { sessionId } = request.params as { sessionId: string };
    // No anchor at all means "the newest page": a reader that has just opened a session wants the
    // end of the log, not the beginning.
    const { since, before } = request.query as { since?: string; before?: string };
    const history = opts.getHistory({ sessionId }, { since, before });
    if (!history) {
      // 404 rather than an empty list: the client should retry later, not record "no history".
      logger.debug(`[lan] history 404 ${sessionId} since=${since ?? '-'} before=${before ?? '-'}`);
      return reply.code(404).send({ error: 'no local history for that session' });
    }
    // One line per read, because "the reader is behind" and "the reader is stuck on one page" look
    // identical from outside and are told apart only by whether the anchors move between reads.
    logger.debug(
      `[lan] history ${sessionId} since=${since ?? '-'} before=${before ?? '-'} ` +
      `entries=${history.entries.length} bytes=${history.entries.reduce((n, e) => n + e.c.length, 0)} ` +
      `hasNewer=${history.hasNewer} hasOlder=${history.hasOlder} reset=${history.reset} ` +
      `cursor=${history.cursor} older=${history.older} from=${clientAddress(request)}`,
    );
    return reply.send({ v: LAN_PROTOCOL_VERSION, ...history });
  });

  /**
   * One tool call's full input and result.
   *
   * Unlike everything else this API carries, the answer is *plaintext* — the session wrote it that
   * way beside the working tree, and it can contain file contents and command output. So the
   * machine key every paired device holds is not enough here: the account has to sign for it, the
   * same proof the actions that change something require.
   */
  app.get('/lan/sessions/:sessionId/tool-content/:callId', async (request, reply) => {
    if (!requireToken(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!opts.getToolContent) {
      return reply.code(404).send({ error: 'this daemon does not serve tool content' });
    }
    const { sessionId, callId } = request.params as { sessionId: string; callId: string };
    // A call id names a file on disk; anything that could walk out of that directory stops here.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId)) {
      logger.debug(`[lan] tool-content refused: callId=${callId.slice(0, 40)}`);
      return reply.code(400).send({ error: 'that is not a tool call id' });
    }
    const target = `${sessionId}:${callId}`;
    if (!requireAccountProof(request, { operation: 'tool-content', target })) {
      return reply.code(403).send({ error: 'account proof required' });
    }
    const content = await opts.getToolContent({ sessionId, callId });
    if (!content) {
      logger.debug(`[lan] tool-content 404 ${target}`);
      return reply.code(404).send({ error: 'no such tool content on this machine' });
    }
    logger.debug(
      `[lan] tool-content ${target} args=${content.args !== undefined} result=${content.result !== undefined} from=${clientAddress(request)}`,
    );
    return reply.send({ v: LAN_PROTOCOL_VERSION, ...content });
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
      logger.debug(`[lan] socket upgrade refused from=${clientAddress(request)}`);
      socket.close(4401, 'unauthorized');
      return;
    }

    subscribers.add(socket);
    logger.debug('[lan] socket reader connected', { readers: subscribers.size });
    for (const payload of opts.getSnapshot?.() ?? []) {
      socket.send(JSON.stringify({ event: 'update', payload }));
    }
    socket.on('close', (code: number, reason: Buffer) => {
      subscribers.delete(socket);
      // Logged because a reader that is never removed is invisible otherwise: the count is the
      // only evidence of whether closes propagate through the relay, and a socket that outlives
      // its client is one the daemon keeps broadcasting to forever.
      logger.debug('[lan] socket reader closed', { readers: subscribers.size, code, reason: reason?.toString() });
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
        logger.debug('[lan] socket frame dropped: not a text frame');
        return;
      }
      let frame: { event?: unknown; payload?: unknown };
      try {
        frame = JSON.parse(text) as { event?: unknown; payload?: unknown };
      } catch {
        logger.debug(`[lan] socket frame dropped: not JSON bytes=${text.length}`);
        return;
      }
      // A reader's heartbeat. The socket is already authenticated, so this needs nothing but a
      // reply: what it is for is the reader knowing the connection is alive *now*, because a socket
      // that died silently — the usual shape after iOS suspends an app — looks open from the client
      // side and would otherwise never be noticed or reconnected. `idleTimeout` does not drop an
      // idle reader (pings are answered by the client's own stack), so silence here means a dead
      // path, not a quiet one.
      if (frame.event === 'ping') {
        socket.send(JSON.stringify({ event: 'pong' }));
        return;
      }
      if (frame.event !== 'send' || typeof frame.payload !== 'object' || frame.payload === null) {
        logger.debug(`[lan] socket frame ignored: event=${String(frame.event)}`);
        return;
      }
      const { sessionId, localId, content } = frame.payload as Record<string, unknown>;
      if (typeof sessionId !== 'string' || typeof localId !== 'string' || typeof content !== 'string') {
        logger.debug('[lan] socket send dropped: malformed payload');
        return;
      }
      logger.debug(`[lan] socket send received session=${sessionId} localId=${localId}`);
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
