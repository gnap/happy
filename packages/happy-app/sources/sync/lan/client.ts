/**
 * Client for the CLI daemon's read-only LAN API.
 *
 * Authentication is a challenge-response over the *machine key* — the 32-byte symmetric secret
 * the CLI generated at auth time and wrapped into the machine record. The App already unwraps
 * that record to decrypt `daemonState`, so the key is on hand and no new key distribution is
 * needed. The key never travels: the client proves possession and receives a short-lived
 * bearer token (90s, enforced server-side) instead.
 *
 * The transport is deliberately plain HTTP, which is why the App declares
 * `NSAllowsLocalNetworking` in app.config.js. A token is therefore sniffable on the LAN; the
 * short TTL is the mitigation, and the API is read-only.
 *
 * All functions take the base URL explicitly rather than reading any global, so the whole
 * module can be exercised against an ephemeral port.
 */

import { hmac_sha256 } from '@/encryption/hmac_sha256';
import { encodeUTF8 } from '@/encryption/text';
import { encodeBase64 } from '@/encryption/base64';
import type { LanHistory, LanIdentity, LanSessionSummary, LanSubagentSummary } from './types';

/** A challenge is worthless once the daemon's nonce expires; don't hang on a wedged host. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * What a *read* through the public relay is allowed, where a read crosses three hops — this device
 * to the relay, the relay's own socket to the daemon, the daemon's server — and the daemon may be
 * on a connection that is slow, saturated, or being re-established after a network change.
 *
 * Only reads, and longer than the LAN's own budget rather than shorter: the hops are added, not
 * replaced. The handshake keeps its ten seconds, because a nonce is worthless once the daemon's
 * window on it has passed and waiting longer would mint a token out of a dead challenge.
 */
const RELAY_HISTORY_TIMEOUT_MS = 60_000;

/** A relayed route is identifiable by its path: `/r/<tag>/…` is only ever served that way. */
const historyTimeoutFor = (url: string): number =>
    url.includes('/r/') ? RELAY_HISTORY_TIMEOUT_MS : HISTORY_TIMEOUT_MS;
/**
 * Reading history is not like the other calls: the response is a page of a session's log, measured
 * in megabytes when the reader is catching up, and it may travel over the relay to a phone on
 * cellular. Ten seconds is enough for the LAN and not for that, and a request that times out is
 * the worst possible failure — the reader threw away a page it had already paid to transfer and
 * asks for the same one again. Failing fast is not worth that.
 */
const HISTORY_TIMEOUT_MS = 45_000;

/** The proof context string — must match `PROOF_CONTEXT` in the CLI's lanServer.ts. */
const PROOF_CONTEXT = 'v1.proof';

export class LanRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
        /** The daemon's own words for the refusal, when it sent any: the reason a caller reports. */
        readonly body?: string
    ) {
        super(message);
        this.name = 'LanRequestError';
    }
}

/**
 * The proof a LAN client returns for a challenge nonce. Must equal `lanProofFor` in
 * `packages/happy-cli/src/daemon/lanServer.ts` byte for byte.
 */
export async function lanProofFor(machineKey: Uint8Array, nonce: string): Promise<string> {
    const mac = await hmac_sha256(machineKey, encodeUTF8(`${PROOF_CONTEXT}.${nonce}`));
    return encodeBase64(mac, 'base64url');
}

async function request(
    url: string,
    init: RequestInit & { token?: string; timeoutMs?: number } = {}
): Promise<Response> {
    const { token, timeoutMs, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...rest,
            signal: controller.signal,
            headers: {
                ...(rest.headers ?? {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Throws a daemon's answer as the error that carries it: the status for what kind of answer it
 * was, and the body because the daemon says why in words this App did not write.
 *
 * Collapsing every non-ok into one undifferentiated `LanRequestError` is how a 413 body-limit
 * and a 403 proof-refusal came to be reported as the same thing — and reading the body matters
 * because it is the daemon's own explanation, not a theory this App substitutes for it.
 */
async function throwAnswer(response: Response, what: string): Promise<never> {
    const text = (await response.text().catch(() => '')).trim();
    let why = text;
    try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string' && parsed.error) {
            why = parsed.error;
        }
    } catch {
        // Not JSON: the daemon's words verbatim.
    }
    throw new LanRequestError(what, response.status, why.slice(0, 1000) || undefined);
}

/**
 * The handshakes in flight, by daemon. Several paths ask at once — a read, the socket that read
 * opens, and the retry after either fails — and each one used to run its own challenge and token
 * exchange: four challenges and two exchanges inside a second, against a daemon that rate-limits
 * exactly that. One handshake is enough for all of them, and they are asking for the same thing.
 *
 * Callers that need a token to *keep* rather than one to use now go through `./credentials`, which
 * caches on top of this; the coalescing here is what makes that cache's misses cheap.
 */
const handshakes = new Map<string, Promise<{ token: string; expiresAt: number }>>();

/**
 * Exchanges the machine key for a bearer token via the challenge-response pair.
 * Throws when the daemon is unreachable or rejects the proof.
 */
export async function authenticate(
    baseUrl: string,
    machineKey: Uint8Array
): Promise<{ token: string; expiresAt: number }> {
    const inFlight = handshakes.get(baseUrl);
    if (inFlight) {
        return inFlight;
    }
    const started = authenticateOnce(baseUrl, machineKey);
    handshakes.set(baseUrl, started);
    try {
        return await started;
    } finally {
        // Cleared either way: a failed handshake must not be handed to everyone who asks next.
        if (handshakes.get(baseUrl) === started) {
            handshakes.delete(baseUrl);
        }
    }
}

async function authenticateOnce(
    baseUrl: string,
    machineKey: Uint8Array
): Promise<{ token: string; expiresAt: number }> {
    const challengeResponse = await request(`${baseUrl}/lan/challenge`, { method: 'POST' });
    if (!challengeResponse.ok) {
        return throwAnswer(challengeResponse, 'challenge rejected');
    }
    const { nonce } = (await challengeResponse.json()) as { nonce: string };

    const proof = await lanProofFor(machineKey, nonce);
    const sessionResponse = await request(`${baseUrl}/lan/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, proof }),
    });
    if (!sessionResponse.ok) {
        return throwAnswer(sessionResponse, 'proof rejected');
    }
    return (await sessionResponse.json()) as { token: string; expiresAt: number };
}

export async function fetchIdentity(baseUrl: string, token: string): Promise<LanIdentity> {
    const response = await request(`${baseUrl}/lan/identity`, { token });
    if (!response.ok) {
        return throwAnswer(response, 'identity request failed');
    }
    return (await response.json()) as LanIdentity;
}

/**
 * One tool call's full input and result, from the machine's own copy.
 *
 * The message stream carries a truncated payload; this is the detail view asking for the rest. It
 * is plaintext on the daemon's disk, so the request carries the account's proof as well as the
 * token — the machine key alone is not enough for this one.
 *
 * Returns null for 404, the daemon's way of saying this machine has no such call — a caller then
 * asks the server, which may still have the session process.
 */
export async function fetchToolContent(
    baseUrl: string,
    token: string,
    sessionId: string,
    callId: string,
    proof?: Record<string, string>,
): Promise<{ args?: unknown; result?: unknown } | null> {
    const response = await request(
        `${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/tool-content/${encodeURIComponent(callId)}`,
        { token, headers: proof },
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        return throwAnswer(response, 'tool content request failed');
    }
    const body = (await response.json()) as { args?: unknown; result?: unknown };
    return { args: body.args, result: body.result };
}

/** The file browser's listing, as the machine that holds the tree answers it. */
export type SessionListing = {
    gitRepo: boolean;
    gitStatus: string;
    gitDiff: string;
    files: string;
    filesTruncated?: boolean;
};

/**
 * The listing behind the file browser.
 *
 * Two `git` commands and an `rg --files` crawl, run by the machine holding the working tree — the
 * same work the App used to ask the session process for through the server. A 404 means this
 * daemon predates the route (or does not know the session), which is the caller's signal to keep
 * its old path.
 */
export async function fetchSessionListing(
    baseUrl: string,
    token: string,
    sessionId: string,
    proof?: Record<string, string>,
): Promise<SessionListing | null> {
    const response = await request(
        `${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/listing`,
        { token, headers: proof },
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        return throwAnswer(response, 'listing request failed');
    }
    const body = (await response.json()) as Partial<SessionListing>;
    return {
        gitRepo: body.gitRepo === true,
        gitStatus: typeof body.gitStatus === 'string' ? body.gitStatus : '',
        gitDiff: typeof body.gitDiff === 'string' ? body.gitDiff : '',
        files: typeof body.files === 'string' ? body.files : '',
        ...(body.filesTruncated === true ? { filesTruncated: true } : {}),
    };
}

/**
 * One file's unstaged diff, from the machine that holds the tree.
 *
 * Null for 404, which is the daemon saying it predates the route or does not know the session;
 * the viewer then keeps its session-RPC fallback.
 */
export async function fetchSessionDiff(
    baseUrl: string,
    token: string,
    sessionId: string,
    path: string,
    proof?: Record<string, string>,
): Promise<string | null> {
    const response = await request(
        `${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/diff?path=${encodeURIComponent(path)}`,
        { token, headers: proof },
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        return throwAnswer(response, 'diff request failed');
    }
    const body = (await response.json()) as { diff?: unknown };
    return typeof body.diff === 'string' ? body.diff : '';
}

/**
 * One file's bytes, from the machine that holds the tree — the same route the native viewer
 * downloads from, read straight into memory instead.
 *
 * A browser has no file system to download into, and the native download task is not a thing
 * there: the App's viewer used to call it unconditionally, so every preview on the web/Tauri
 * build failed before a request left the device — reported as "the machine did not answer over
 * LAN or relay", which was the truth about the addresses and a lie about the machine. Null is
 * the 404 that means "no such file, or a daemon without this route".
 */
export async function fetchSessionFileBytes(
    baseUrl: string,
    token: string,
    sessionId: string,
    path: string,
    proof?: Record<string, string>,
): Promise<{ bytes: Uint8Array; size: number } | null> {
    const response = await request(
        `${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
        {
            token,
            headers: { ...(proof ?? {}) },
            // A file is not a listing: it may be megabytes and it may travel over the relay.
            timeoutMs: historyTimeoutFor(baseUrl),
        },
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        return throwAnswer(response, 'file request failed');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, size: bytes.byteLength };
}

/**
 * One directory of the machine's working tree, packed by the machine.
 *
 * A reader with a file system streams this to disk; a browser has no file system, so this reads
 * the archive into memory and lets the caller hand it to a save dialog. Null is the 404 meaning
 * "no such directory, or a daemon without this route".
 */
export async function fetchSessionFolderBytes(
    baseUrl: string,
    token: string,
    sessionId: string,
    path: string,
    proof?: Record<string, string>,
): Promise<{ bytes: Uint8Array; name: string; size: number } | null> {
    const response = await request(
        `${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/folder?path=${encodeURIComponent(path)}`,
        {
            token,
            headers: { ...(proof ?? {}) },
            // A tree can take longer than a listing; the relay's own budget already exists.
            timeoutMs: historyTimeoutFor(baseUrl),
        },
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        return throwAnswer(response, 'folder request failed');
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const named = /filename="([^"]+)"/.exec(disposition)?.[1];
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, name: named || 'folder.tar.gz', size: bytes.byteLength };
}

/**
 * A read-only grant over one session's working tree, for a page a browser loads by URL.
 *
 * Minting is account-signed like every other plaintext read. What comes back is the only thing an
 * iframe's own requests can carry: subresource loads send no headers, so the token in the URL is
 * the credential. Null is the 404 of a daemon without the route, where the viewer falls back to
 * drawing the page from the bytes it fetched.
 */
export async function fetchPreviewGrant(
    baseUrl: string,
    token: string,
    sessionId: string,
    path: string,
    proof?: Record<string, string>,
): Promise<{ token: string; expiresAt: number } | null> {
    const response = await request(`${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/preview`, {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json', ...(proof ?? {}) },
        body: JSON.stringify({ path }),
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        return throwAnswer(response, 'preview request failed');
    }
    const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
    if (typeof body.token !== 'string' || typeof body.expiresAt !== 'number') {
        return null;
    }
    return { token: body.token, expiresAt: body.expiresAt };
}

/**
 * Where a preview is loaded from, mirroring the file's own path.
 *
 * The path is the point: a page's `./style.css` resolves against the URL it was loaded from, so
 * the URL has to end in the same directory the file lives in. The daemon serves that path under
 * the session's working tree, and the token is what each of those requests carries.
 */
export function previewUrlFor(baseUrl: string, token: string, path: string): string {
    const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return `${baseUrl}/lan/preview/${encodeURIComponent(token)}/${encodedPath}`;
}

export type LanSessionList = {
    sessions: LanSessionSummary[];
    /**
     * The daemon's state revision, when it publishes one. Absent on an older daemon, which is what
     * lets a reader tell "no revision in this protocol" from "revision zero".
     */
    revision?: number;
    /**
     * Sessions the daemon has archived. A reader applies these as deletions; the server's own
     * copy may lag until the daemon's replay reaches it.
     */
    tombstones?: Array<{ sessionId: string; tag?: string; sessionUid?: string; at: number }>;
};

export async function fetchSessions(baseUrl: string, token: string): Promise<LanSessionList> {
    const response = await request(`${baseUrl}/lan/sessions`, { token });
    if (!response.ok) {
        return throwAnswer(response, 'sessions request failed');
    }
    const body = (await response.json()) as {
        sessions?: LanSessionSummary[];
        revision?: unknown;
        tombstones?: unknown;
    };
    return {
        sessions: Array.isArray(body.sessions) ? body.sessions : [],
        ...(typeof body.revision === 'number' ? { revision: body.revision } : {}),
        ...(Array.isArray(body.tombstones)
            ? {
                tombstones: (body.tombstones as Array<{ sessionId?: unknown; tag?: unknown; sessionUid?: unknown; at?: unknown }>)
                    .filter((tombstone): tombstone is { sessionId: string; tag?: string; sessionUid?: string; at: number } =>
                        typeof tombstone?.sessionId === 'string' && typeof tombstone.at === 'number')
                    .map((tombstone) => ({
                        sessionId: tombstone.sessionId,
                        ...(typeof tombstone.tag === 'string' ? { tag: tombstone.tag } : {}),
                        ...(typeof tombstone.sessionUid === 'string' ? { sessionUid: tombstone.sessionUid } : {}),
                        at: tombstone.at,
                    })),
            }
            : {}),
    };
}

/**
 * Fetches one page of a session's local history.
 *
 * `since` reads forward from a boundary — what following a session uses; `before` reads back from
 * one, which is scrolling towards older messages; neither reads the newest page, which is what a
 * reader that has just opened a session wants. A reader that starts from where it left off instead
 * has to carry every entry written while it was away before it can show anything recent, and on a
 * long session that never finishes.
 *
 * Returns null for 404, which the daemon uses for "this machine has no local history for that
 * session yet" — a retryable condition, deliberately distinct from the 401 an unauthorised
 * caller gets. Other failures throw.
 */
export async function fetchHistory(
    baseUrl: string,
    token: string,
    sessionId: string,
    page: { since?: string; before?: string; subagent?: string; site?: string; fromN?: number; toN?: number } = {}
): Promise<LanHistory | null> {
    const params = new URLSearchParams();
    if (page.since) {
        params.set('since', page.since);
    }
    if (page.before) {
        params.set('before', page.before);
    }
    if (page.subagent) {
        params.set('subagent', page.subagent);
    }
    // A bounded repair by the log's own coordinates: one writer's counters, inclusive. The
    // machine filters its plaintext stamp, so this asks for exactly what the reader is missing
    // and never names the server's sequence.
    if (page.site) {
        params.set('site', page.site);
    }
    if (page.fromN !== undefined) {
        params.set('from_n', String(page.fromN));
    }
    if (page.toN !== undefined) {
        params.set('to_n', String(page.toN));
    }
    // A page is read to be shown, and the reader decrypts at most this many entries anyway: asking
    // for more is paying for bytes and parse work that the caller throws away (measured: 546
    // entries / ~600KB per follow read for a 150-entry use).
    params.set('limit', '150');
    const query = `?${params.toString()}`;
    const response = await request(
        `${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/history${query}`,
        { token, timeoutMs: historyTimeoutFor(baseUrl) }
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        return throwAnswer(response, 'history request failed');
    }
    return (await response.json()) as LanHistory;
}

/**
 * The sub-agent streams this machine's log holds for a session.
 *
 * A listing, not a stream: one stream is read through `fetchHistory` with `subagent` set, so it
 * gets the same byte anchors and paging as the main conversation. Null is the 404 of a machine
 * with no log for the session — or a build from before the split — and the caller treats both as
 * "this machine cannot answer that".
 */
export async function fetchSessionSubagents(
    baseUrl: string,
    token: string,
    sessionId: string,
): Promise<LanSubagentSummary[] | null> {
    const response = await request(
        `${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/subagents`,
        { token, timeoutMs: historyTimeoutFor(baseUrl) },
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        return throwAnswer(response, 'sub-agent listing failed');
    }
    const body = (await response.json()) as { subagents?: unknown };
    if (!Array.isArray(body.subagents)) {
        return null;
    }
    return (body.subagents as Array<Record<string, unknown>>)
        .filter((item) => typeof item?.subagent === 'string'
            && typeof item.entries === 'number'
            && typeof item.firstAt === 'number'
            && typeof item.lastAt === 'number')
        .map((item) => ({
            subagent: item.subagent as string,
            ...(typeof item.taskCall === 'string' ? { taskCall: item.taskCall } : {}),
            entries: item.entries as number,
            firstAt: item.firstAt as number,
            lastAt: item.lastAt as number,
        }));
}

/**
 * What a daemon says about a restart it was asked to perform.
 *
 * `success` and `error` keep the meaning every build has answered with. The rest is additive and
 * present when the request asked for it (`expect: 'accepted'` or a `generation`): the machine's
 * acceptance, the point the work has reached, and the generation it holds after this request. A
 * caller that does not read them loses nothing; a caller that does can tell "the machine took it"
 * from "the machine did it", and a repeat from a new restart.
 */
export type LanRestartVerdict = {
    success: boolean;
    newSessionId?: string;
    error?: string;
    message?: string;
    /** Whether the machine has taken responsibility for the restart. It need not be finished. */
    accepted?: boolean;
    /** `scheduled` while accepted, then `running` / `failed` / `refused` once resolved. */
    stage?: string;
    /** The session the restart applies to. Named so a caller need not assume it is the same id. */
    ref?: string;
    /** The generation the machine holds for the session after answering this request. */
    generation?: number;
    /** The phase the machine reported with the answer. */
    phase?: string;
    /** Why the answer is what it is: `in-flight`, `already-applied`, `generation-ahead`, … */
    reason?: string;
};

/**
 * What a caller is asking a restart to do beyond restarting.
 *
 * Defined once because two roads carry it — the machine's LAN route and the server's RPC to the
 * same daemon handler — and an option that means "a repeat is not a second restart" must not be
 * lost on one of them.
 */
export type RestartAsk = {
    /**
     * Move the session between the daemon's domain and the user's desktop session.
     *
     * Sent in the body rather than the headers because it changes what the machine should do,
     * not who is asking. Omitted when unchanged: a restart with no mode keeps the session's own.
     */
    requiresDesktop?: boolean;
    /**
     * The generation this device observed when it decided to ask.
     *
     * This is the *observed* generation — the revision the listed phase reflects — not the log's
     * newest want. During a restart the want is already one ahead of the process, and sending the
     * want would read to the machine as a caller ahead of it and be refused. Sent as observed, a
     * machine that has moved past it answers "already applied" instead of killing the process
     * twice, and a machine in the middle answers "in flight".
     *
     * Omitted when this device holds no runtime row (an older daemon): the machine then falls
     * back to its time window, which is exactly the behavior those builds always had.
     */
    generation?: number;
    /**
     * Ask for the machine's acceptance rather than the finished outcome.
     *
     * A restart outlives a request: the old process has to go, a new one boot, authenticate and
     * register. Waiting for that is what made the answer a guess on a socket that reconnects
     * sooner; the row's phase carries the rest. A build that predates this option ignores it and
     * waits, so the request still works — it simply answers later.
     */
    expectAccepted?: boolean;
    /**
     * The profile's environment as it is *now*, sent with the ask.
     *
     * The daemon can recover the last user message's profile, but that is the profile as it was
     * when the message was sent. A person edits a profile and restarts without sending anything;
     * the restarted process would then boot with the old route or the old credentials until the
     * next message. The caller that holds the current profile is the App, so it says so here.
     */
    environmentVariables?: Record<string, string>;
    /** The profile's relay switch, for the same reason as the environment above. */
    proxyViaRelay?: boolean;
};

/**
 * The body a restart request carries, or null when it has nothing to say.
 *
 * The daemon rejects a POST that declares JSON with an empty body before the route runs, so
 * "nothing to ask" must be no body at all rather than `{}`.
 */
export function restartAskBody(
    ask: RestartAsk | undefined
): {
    requiresDesktop?: boolean;
    generation?: number;
    expect?: 'accepted';
    environmentVariables?: Record<string, string>;
    proxyViaRelay?: boolean;
} | null {
    if (ask === undefined) {
        return null;
    }
    const body: {
        requiresDesktop?: boolean;
        generation?: number;
        expect?: 'accepted';
        environmentVariables?: Record<string, string>;
        proxyViaRelay?: boolean;
    } = {
        ...(ask.requiresDesktop !== undefined ? { requiresDesktop: ask.requiresDesktop } : {}),
        ...(ask.generation !== undefined ? { generation: ask.generation } : {}),
        ...(ask.expectAccepted ? { expect: 'accepted' as const } : {}),
        ...(ask.environmentVariables !== undefined ? { environmentVariables: ask.environmentVariables } : {}),
        ...(ask.proxyViaRelay !== undefined ? { proxyViaRelay: ask.proxyViaRelay } : {}),
    };
    return Object.keys(body).length > 0 ? body : null;
}

/**
 * Asks a daemon to restart a session, on the daemon's own API.
 *
 * Returns null only for the 404 of a daemon that has nothing to restart — a build that predates
 * the route, or no session by that id — which is the one answer that belongs to another channel.
 * Every other non-ok is thrown with the daemon's own words: a proof it rejected and a body over
 * its limit are both answers about *this request*, and walking them to another channel is sending
 * the same bytes to the same mistake.
 *
 * The daemon's whole reason for the route is that a session is restarted because its machine has
 * been rebuilt, and the machine's own channel is the one that is up at that moment — the server's
 * is not necessarily, which is how a restart came to fail with "socket disconnected" while the
 * machine sat there answering reads on the LAN.
 */
export async function restartSessionAt(
    baseUrl: string,
    token: string,
    sessionId: string,
    /** The account's proof of this request, when this device can make one. */
    proof?: Record<string, string>,
    ask?: RestartAsk
): Promise<LanRestartVerdict | null> {
    const body = restartAskBody(ask);
    const response = await request(`${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/restart`, {
        method: 'POST',
        token,
        // A body is only sent when there is something to say: a POST declaring `application/json`
        // with nothing in it is rejected by the daemon's body parser before the route runs.
        headers: { ...(proof ?? {}), ...(body !== null ? { 'content-type': 'application/json' } : {}) },
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
        // A restart kills a process and starts another. It is not slow, but it is not a read
        // either, and the shortest timeout in this file is for questions that are one round trip.
        timeoutMs: historyTimeoutFor(baseUrl),
    });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        return throwAnswer(response, 'restart request failed');
    }
    return (await response.json()) as LanRestartVerdict;
}

/**
 * Asks a daemon to forward a control call to one of its sessions.
 *
 * The parameters are the same ciphertext the server route carries — the session's own key opens
 * them, and neither the daemon nor the relay holds it — so this walks the same bytes down a shorter
 * path. True means the daemon has a live session by that id and handed it over; false means the
 * daemon has no such session, which is the one answer that belongs to another channel. Everything
 * else — a token it would not take, a proof it rejected, a body over its limit — is thrown with
 * the daemon's own words, because "who has this session" and "no, and here is why" are different
 * questions, and only the first is ever somebody else's to answer.
 */
export async function sessionControlAt(
    baseUrl: string,
    token: string,
    sessionId: string,
    method: 'abort' | 'permission',
    params: string,
    /** The account's proof of this request, when this device can make one. */
    proof?: Record<string, string>
): Promise<boolean> {
    const response = await request(`${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/control`, {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json', ...(proof ?? {}) },
        body: JSON.stringify({ method, params }),
        // Not a read: the daemon answers as soon as the session's socket has taken it.
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 404) {
        return false;
    }
    if (!response.ok) {
        return throwAnswer(response, 'control request failed');
    }
    return true;
}

/**
 * Asks a daemon to delete one of its sessions, as a transaction in its own log.
 *
 * This is a deletion, not a request to hide a row: the daemon records it, keeps the fact after a
 * restart, and replays it to the server on its own cursor. Which is why it is the *machine* that is
 * asked even when the row came from the server — the machine is the part of the account that can
 * still remember something happened after this App has forgotten it.
 *
 * False only for the 404 of a daemon that has nothing to delete — a build without the route, or no
 * session by that id — and that answer belongs to another channel, because the server may hold
 * what this machine does not. Everything else is thrown with the daemon's own words: a refusal is
 * about this device, and walking it to the server would ask a different party the same question.
 */
export async function deleteSessionAt(
    baseUrl: string,
    token: string,
    sessionId: string,
    /** The account's proof of this request, when this device can make one. */
    proof?: Record<string, string>
): Promise<boolean> {
    const response = await request(`${baseUrl}/lan/v2/sessions/${encodeURIComponent(sessionId)}/delete`, {
        method: 'POST',
        token,
        headers: { ...(proof ?? {}) },
        // A log append and a state write, answered as soon as they are durable.
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 404) {
        return false;
    }
    if (!response.ok) {
        return throwAnswer(response, 'delete request failed');
    }
    return true;
}

/**
 * The path a daemon built before the v2 routes answers, and always meant a deletion.
 *
 * Called only after the canonical route has said it does not exist on that machine. The proof for
 * this request names `archive`, because that is the word the old route has always checked.
 */
export async function deleteSessionAtLegacy(
    baseUrl: string,
    token: string,
    sessionId: string,
    proof?: Record<string, string>
): Promise<boolean> {
    const response = await request(`${baseUrl}/lan/sessions/${encodeURIComponent(sessionId)}/archive`, {
        method: 'POST',
        token,
        headers: { ...(proof ?? {}) },
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 404) {
        return false;
    }
    if (!response.ok) {
        return throwAnswer(response, 'delete request failed');
    }
    return true;
}

/**
 * Asks a daemon to archive one of its sessions: stop it, keep the row and its history.
 *
 * Not a deletion, and deliberately not interchangeable with one: a daemon that does not have this
 * route answers 404, and the caller must say so rather than fall back to the legacy delete path.
 * A 409 means the machine has no lineage it could archive; it is thrown with the daemon's words.
 */
export async function archiveSessionAt(
    baseUrl: string,
    token: string,
    sessionId: string,
    proof?: Record<string, string>
): Promise<boolean> {
    const response = await request(`${baseUrl}/lan/v2/sessions/${encodeURIComponent(sessionId)}/archive`, {
        method: 'POST',
        token,
        headers: { ...(proof ?? {}) },
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 404) {
        return false;
    }
    if (!response.ok) {
        return throwAnswer(response, 'archive request failed');
    }
    return true;
}
