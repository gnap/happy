import { authenticate } from './client';

/**
 * The bearer token for one daemon, shared by everything in this App that talks to it.
 *
 * Without this, a token is a property of a *reader*: every session being polled carries its own
 * `LanConnection`, so every session re-runs the challenge-response on its own schedule. A daemon
 * serving four sessions therefore sees four handshakes per token lifetime rather than one, and the
 * count scales with how many sessions the App happens to be syncing — which is the traffic that a
 * rate-limited, nonce-backed handshake path punishes hardest.
 *
 * A token is a property of the daemon, not of the caller. This keeps one, keyed by address:
 *
 * - **Refreshed ahead of expiry, not after a rejection.** The daemon's tokens live 90s. A read
 *   that starts with 3s left fails with a 401 and pays a second round trip to recover, and the
 *   recovery is itself a handshake at exactly the moment the client is already in a hurry. Here a
 *   token with little life left is replaced *in the background* while the current one still
 *   answers, so no read ever blocks on a handshake and none ever sees a 401 for age.
 * - **One handshake at a time per address.** Everything that asks while a refresh is in flight
 *   waits on the same promise.
 *
 * The socket is deliberately not a customer of this: it authenticates with a nonce the upgrade
 * spends, and a spent nonce takes any token minted from it down with it (the daemon checks the
 * nonce is still on record). Sharing one credential between the two would mean every socket open
 * invalidated the reads. The socket fetches its own; see `./socket`.
 *
 * Nothing here sends anything: a token is only ever fetched, and only by a caller that has already
 * decided to use this daemon.
 */

type Credential = {
    token: string;
    /** Epoch ms, as the daemon stated it. */
    expiresAt: number;
};

/**
 * How long before expiry a token stops being used for a new request.
 *
 * It has to exceed the slowest request this App makes or a read can start valid and finish
 * rejected: a history page is allowed 45s. It also has to be small enough that the token is
 * genuinely refreshed well before it dies, or every read pays the background refresh's latency.
 */
const REFRESH_AHEAD_MS = 55_000;

const credentials = new Map<string, Credential>();
const inFlight = new Map<string, Promise<Credential>>();

/** A token is returned while it still has this much life; below it, a refresh is started. */
function needsRefresh(credential: Credential, now: number): boolean {
    return credential.expiresAt - now <= REFRESH_AHEAD_MS;
}

function handshake(baseUrl: string, machineKey: Uint8Array): Promise<Credential> {
    const existing = inFlight.get(baseUrl);
    if (existing) {
        return existing;
    }
    const started = authenticate(baseUrl, machineKey)
        .then(({ token, expiresAt }) => {
            const credential: Credential = { token, expiresAt };
            credentials.set(baseUrl, credential);
            return credential;
        })
        .finally(() => {
            // Cleared either way: a failed handshake must not be handed to everyone who asks next.
            if (inFlight.get(baseUrl) === started) {
                inFlight.delete(baseUrl);
            }
        });
    inFlight.set(baseUrl, started);
    return started;
}

/**
 * A token for this daemon, from the cache when it has life left, otherwise from a new handshake.
 *
 * A refresh is fired without being awaited: the caller gets the token it can still use, and the
 * next call — a couple of seconds later, for a session that is being polled — finds a fresh one
 * already in place. A failure there is dropped on purpose: the old token is still valid, and a
 * caller that arrives after it has actually expired waits for a handshake instead.
 */
export function getLanCredential(baseUrl: string, machineKey: Uint8Array): Promise<{ token: string; expiresAt: number }> {
    const now = Date.now();
    const cached = credentials.get(baseUrl);
    if (cached && cached.expiresAt > now) {
        if (needsRefresh(cached, now)) {
            // Not awaited and not returned: it is a refresh for the *next* caller, and an
            // unhandled rejection here would turn a daemon restart into a crash report.
            void handshake(baseUrl, machineKey).catch(() => undefined);
        }
        return Promise.resolve(cached);
    }
    return handshake(baseUrl, machineKey);
}

/**
 * Drops a token the daemon has rejected.
 *
 * The daemon only rejects a token it cannot verify — it does not know the nonce any more, which is
 * what a daemon restarted since the token was minted looks like. Nothing else invalidates one: a
 * dropped *socket* says nothing about a token that is still on the daemon's books, and voiding it
 * there is what turns one socket's death into a handshake by every reader at once.
 */
export function invalidateLanCredential(baseUrl: string): void {
    credentials.delete(baseUrl);
}

/** Test seam: the module is process-wide state, and one test must not inherit the last one's token. */
export function resetLanCredentials(): void {
    credentials.clear();
    inFlight.clear();
}
