/**
 * Turns a profile's proxy setting into the environment an agent should see.
 *
 * A profile has two ways to move its traffic off this machine, and they are not alternatives to
 * each other in the profile editor: one is a switch, the other is an ordinary proxy variable.
 *
 * - The relay switch (opt-in). Everything the agent sends goes to the daemon's loopback proxy,
 *   which carries it through the relay. The relay then connects to the profile's SOCKS5 hop when
 *   the environment names one, or dials the target itself when it does not. This is the path for a
 *   machine that cannot reach the hop, and the one that puts the API traffic behind the relay too.
 * - The environment's own `ALL_PROXY` (or another `*_PROXY` spelling) set to `socks5://` or
 *   `socks5h://`. With the switch off, that hop is dialled from this machine, exactly as the
 *   profile asks. With neither a hop nor the switch, the agent keeps whatever the machine has.
 *
 * Either way the agent never sees a socks URL: the profile's socks entries are removed and
 * replaced with one loopback HTTP proxy URL that the daemon minted for this session, and the
 * daemon does the SOCKS5 leg.
 *
 * This is fail-closed. If a profile asks for a route but the daemon did not provide a local proxy
 * (a terminal-started session, or a spawn that predates this feature), the socks entries are still
 * removed and nothing is put in their place. An agent that fell back to dialling the hop directly
 * would be sending traffic from the wrong address, which is exactly what the profile chose against.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { notifyDaemonNetworkProxy } from '@/daemon/controlClient';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { configuration } from '@/configuration';

/** Where the daemon puts the loopback proxy URL it minted for this session. */
export const LOCAL_PROXY_ENV = 'HAPPY_LOCAL_PROXY_URL';
/** `1` opts this session into the relay leg; the daemon sets it from the spawn options. */
export const VIA_RELAY_ENV = 'HAPPY_PROXY_VIA_RELAY';
/**
 * The name of a route this machine serves, as the profile names it.
 *
 * A route's definition — the hop and its credentials — lives on the relay. The machine only knows
 * which names it exposes and on which port, so a profile selecting one carries a name, never an
 * address.
 */
export const ROUTE_ENV = 'HAPPY_PROXY_ROUTE';
/**
 * The reserved route name meaning "no proxy at all".
 *
 * Not a route the relay defines: naming it is the profile saying the agent should reach the
 * network itself, with nothing in its environment pointing elsewhere. It exists because an empty
 * route means "the profile has no opinion", which for a profile that also names a SOCKS5 hop is
 * not the same thing.
 */
export const DIRECT_ROUTE = 'direct';

const PROXY_KEYS = [
    'ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
] as const;
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const;
const NO_SOCKS_MESSAGE = '[proxy] profile routes traffic but no local proxy is available for this session; the agent will not be given one';

export type ProxyRegistration = {
    /** The per-session token the daemon matches a request against. */
    token: string;
    /**
     * The profile's SOCKS5 URL, credentials included. Never logged. Absent means the relay is the
     * egress itself: it dials the target and the tunnel carries the agent's bytes.
     */
    socks5?: string;
    viaRelay: boolean;
    /** A session name for daemon logs; never the address. */
    label?: string;
};

export type NetworkProxyPolicy = {
    /** The profile environment with its proxy entries resolved for the agent. */
    env: Record<string, string>;
    /** What the daemon needs in order to serve this session, or null when no hop applies. */
    registration: ProxyRegistration | null;
    /**
     * Resolves once the daemon has the route, whether or not the request succeeded.
     *
     * A turn must not begin before this: the agent's first request would otherwise arrive at a
     * proxy that has not yet been told where to send it, and be refused for a reason that has
     * already been fixed a millisecond later.
     */
    settled: Promise<void>;
};

/** The values to put back when this policy stops applying. Undefined means "was not set". */
let injected: Map<string, string | undefined> | null = null;
let active: ProxyRegistration | null = null;
let settling: Promise<void> = Promise.resolve();
let warnedNoLocalProxy = false;
let warnedUnknownRoute = false;
/** SOCKS5 entries taken out of the environment; the policy reads them instead. Never logged. */
let spawnHop: Record<string, string> = {};

/**
 * Moves the machine's SOCKS5 entries out of `process.env`, keeping them for the policy.
 *
 * Those entries name a hop the agent must not dial itself, but until a route is applied the
 * environment is the only place they exist. Leaving them there also makes them this process's
 * own settings: axios reads `ALL_PROXY` even when the caller never configured one, and it cannot
 * speak SOCKS5 — it rewrites the request protocol to `socks5h:` and follow-redirects aborts with
 * "protocol mismatch" before the session is created. Call this once, before any HTTP request and
 * before any command runs.
 *
 * HTTP(S) proxy entries are left alone: this process can use those, and stripping them would
 * take away a machine's only route to the server. Only the SOCKS5 spellings are captured, and
 * only the first value wins so a later profile message still decides its own hop.
 */
export function captureSpawnProxyEnv(): void {
    for (const key of PROXY_KEYS) {
        const value = process.env[key];
        if (!isSocks5(value)) continue;
        if (spawnHop[key] === undefined) spawnHop[key] = value;
        delete process.env[key];
    }
}

/** Forgets the captured spawn hop. Tests use this to isolate the module; runtime never needs it. */
export function resetSpawnProxyEnvCapture(): void {
    spawnHop = {};
}

/**
 * Applies the profile's proxy decision to `process.env` and returns the environment the caller
 * should merge for the agent.
 *
 * `process.env` is the channel because that is what the SDK and the agent process inherit; the
 * returned record is what a caller stores as the profile's own env, and it must not contain the
 * socks entries or they would shadow the loopback URL when the two are spread together.
 */
export function applyNetworkProxyPolicy(
    profileEnv: Record<string, string>,
    options?: { viaRelay?: boolean; label?: string },
): NetworkProxyPolicy {
    restoreInjection();

    const env = { ...profileEnv };
    // The spawn env is part of the source: on the first turn the profile's socks entries came in
    // through the daemon's spawn env, and no message has carried them yet. They are no longer in
    // `process.env` — `captureSpawnProxyEnv` holds them, so the CLI's own HTTP clients never see
    // a socks URL — which is why the capture is spread in explicitly. The profile's own values
    // are expanded first: the hop's address is often `${VAR}` naming a credential held by the
    // daemon, and the daemon needs the resolved URL, not the placeholder.
    const expandedProfile = expandEnvironmentVariables(profileEnv, process.env);

    // A named route is a machine-level answer: the daemon already listens on that route's fixed
    // port and forwards every request through the relay, so there is no token to register and no
    // hop for this process to see. It wins over the profile's own socks entries — naming a route
    // is saying "use that path", and the route is where the machine's operator put it.
    const routeName = (expandedProfile[ROUTE_ENV] ?? process.env[ROUTE_ENV] ?? '').trim();
    if (routeName === DIRECT_ROUTE) {
        // "Direct" is a decision, not an absence: the agent gets no proxy, no matter what the
        // profile's environment or the relay switch would otherwise have done. Removing the
        // entries from this process as well is the only way to keep them out of the agent it
        // inherits — the SDK takes its environment from here.
        delete env[ROUTE_ENV];
        for (const key of PROXY_KEYS) {
            delete env[key];
            delete process.env[key];
        }
        logger.debug('[proxy] direct for this session: the agent is given no proxy');
        return { env, registration: null, settled: clearRegistration() };
    }
    if (routeName) {
        delete env[ROUTE_ENV];
        for (const key of PROXY_KEYS) delete env[key];
        const port = readRoutePort(routeName);
        if (port === null) {
            if (!warnedUnknownRoute) {
                warnedUnknownRoute = true;
                logger.warn(`[proxy] route "${routeName}" is not served by this machine; the agent will not be given a proxy`);
            }
            return { env, registration: null, settled: clearRegistration() };
        }
        const previous = new Map<string, string | undefined>();
        for (const key of [...PROXY_KEYS, ...NO_PROXY_KEYS]) previous.set(key, process.env[key]);
        injected = previous;
        const routeUrl = `http://127.0.0.1:${port}`;
        for (const key of PROXY_KEYS) process.env[key] = routeUrl;
        const routeNoProxy = buildNoProxy(expandedProfile);
        for (const key of NO_PROXY_KEYS) process.env[key] = routeNoProxy;
        logger.debug(`[proxy] named route ${routeName} -> 127.0.0.1:${port} for this session`);
        return { env, registration: null, settled: clearRegistration() };
    }

    const source: Record<string, string | undefined> = { ...process.env, ...spawnHop, ...expandedProfile };
    const socks5 = findSocks5(source);

    // Off unless asked for: a profile that names a hop keeps the route it had — the daemon
    // dials the hop from this machine — and only the profiles that opt in pay for the relay leg.
    const viaRelay = options?.viaRelay ?? process.env[VIA_RELAY_ENV] === '1';

    // Neither a hop nor the relay switch: there is nothing to route, and the agent keeps the
    // environment the machine gave it.
    if (!socks5 && !viaRelay) {
        return { env, registration: null, settled: clearRegistration() };
    }

    // The agent gets one proxy, not a mix. Whatever proxy spellings the profile carried are
    // replaced by the loopback URL below; leaving a non-socks one in this record would let it
    // override the loopback URL when the record is spread over process.env.
    for (const key of PROXY_KEYS) delete env[key];

    const localUrl = localProxyUrl();
    const token = localUrl ? tokenOf(localUrl) : null;
    if (!localUrl || !token) {
        if (!warnedNoLocalProxy) {
            warnedNoLocalProxy = true;
            logger.warn(NO_SOCKS_MESSAGE);
        }
        return { env, registration: null, settled: clearRegistration() };
    }

    const previous = new Map<string, string | undefined>();
    for (const key of [...PROXY_KEYS, ...NO_PROXY_KEYS]) previous.set(key, process.env[key]);
    injected = previous;

    for (const key of PROXY_KEYS) process.env[key] = localUrl;
    const noProxy = buildNoProxy(expandedProfile);
    for (const key of NO_PROXY_KEYS) process.env[key] = noProxy;

    const registration: ProxyRegistration = {
        token,
        // Absent when the profile names no hop: the relay becomes the egress and dials the target.
        ...(socks5 ? { socks5 } : {}),
        viaRelay,
        ...(options?.label ? { label: options.label } : {}),
    };
    active = registration;
    settling = settleNotifying(token, registration);
    logger.debug(socks5
        ? `[proxy] ${viaRelay ? 'relay to hop' : 'direct hop'} ${describeHop(socks5)} for this session`
        : '[proxy] relay egress for this session');
    return { env, registration, settled: settling };
}

/**
 * Removes the loopback proxy and tells the daemon to forget the route.
 *
 * Used when a profile is cleared back to the daemon baseline: the agent should return to whatever
 * the machine had, not keep a proxy the profile no longer names.
 */
export function resetNetworkProxyPolicy(): Promise<void> {
    restoreInjection();
    return clearRegistration();
}

/**
 * Re-sends the active route.
 *
 * The daemon can restart under a live session, and its route table lives in memory. A message is
 * the one point where the two processes are known to be talking anyway, so re-asserting there
 * costs a loopback request and removes the case where the proxy silently stops after a daemon
 * upgrade.
 */
export function reassertNetworkProxy(): void {
    if (active) settling = settleNotifying(active.token, active);
}

/**
 * Resolves once the daemon has answered the most recent route change.
 *
 * A turn may await this before starting the agent: the agent's first request would otherwise
 * reach the loopback proxy before the route exists and be refused for a reason that is about to
 * stop being true.
 */
export function networkProxySettled(): Promise<void> {
    return settling;
}

/** Removes every proxy spelling from a stored profile env, for a merge that must not resurrect one. */
export function stripNetworkProxyKeys(env: Record<string, string>): Record<string, string> {
    const copy = { ...env };
    for (const key of PROXY_KEYS) delete copy[key];
    return copy;
}

/**
 * Whether a profile's environment changed in a way the agent process can see.
 *
 * Proxy keys are excluded on purpose. They never reach the agent — the policy replaces them with
 * the daemon's loopback URL, which is the same whatever the hop is — so a profile that still names
 * a hop would otherwise look different on every message: the message carries the socks entry, the
 * applied environment has it stripped, and the comparison kept respawning the agent every turn.
 */
export function profileEnvChanged(current: Record<string, string>, next: Record<string, string>): boolean {
    const left = stripNetworkProxyKeys(current);
    const right = stripNetworkProxyKeys(next);
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined).sort();
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined).sort();
    if (leftKeys.length !== rightKeys.length) return true;
    return leftKeys.some((key, i) => key !== rightKeys[i] || left[key] !== right[key]);
}

function restoreInjection(): void {
    if (!injected) return;
    for (const [key, value] of injected) {
        // A socks entry captured from the spawn env must not come back on reset: restoring it
        // would hand the agent the very direct path this policy exists to remove.
        if (value === undefined || isSocks5(value)) delete process.env[key];
        else process.env[key] = value;
    }
    injected = null;
}

function clearRegistration(): Promise<void> {
    if (!active) return settling;
    const token = active.token;
    active = null;
    settling = settleNotifying(token, null);
    return settling;
}

/**
 * The daemon not learning a route is not an exception for the caller: an unregistered token is
 * refused at the proxy, which is the fail-closed answer, and a retry happens on the next message.
 */
function settleNotifying(
    token: string,
    config: { socks5?: string; viaRelay: boolean; label?: string } | null,
): Promise<void> {
    return notifyDaemonNetworkProxy(token, config).then(() => undefined, () => undefined);
}

function findSocks5(env: Record<string, string | undefined>): string | null {
    for (const key of PROXY_KEYS) {
        const value = env[key];
        if (isSocks5(value)) return value!.trim();
    }
    return null;
}

function isSocks5(value: string | undefined): value is string {
    return typeof value === 'string' && /^socks5h?:\/\//i.test(value.trim());
}

/**
 * The port this machine assigned to a route, from the same file the daemon reads.
 *
 * Read rather than asked for over the control channel: both processes read one file, and a change
 * to it is already defined to need a daemon restart. A route that is not in the file is a route
 * this machine does not serve, and the caller fails closed rather than guessing a port.
 */
function readRoutePort(name: string): number | null {
    try {
        const home = process.env.HAPPY_HOME_DIR ?? configuration.happyHomeDir;
        const parsed = JSON.parse(readFileSync(join(home, 'proxy-routes.json'), 'utf8')) as Record<string, unknown>;
        const port = Number(parsed[name]);
        return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
    } catch {
        return null;
    }
}

function localProxyUrl(): string | null {
    const value = process.env[LOCAL_PROXY_ENV]?.trim();
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' ? value : null;
    } catch {
        return null;
    }
}

function tokenOf(url: string): string | null {
    try {
        const token = decodeURIComponent(new URL(url).username);
        return token.length > 0 ? token : null;
    } catch {
        return null;
    }
}

function buildNoProxy(env: Record<string, string>): string {
    const existing = env.NO_PROXY ?? env.no_proxy ?? process.env.NO_PROXY ?? process.env.no_proxy ?? '';
    const entries = new Set(existing.split(',').map((entry) => entry.trim()).filter(Boolean));
    for (const host of ['localhost', '127.0.0.1', '::1']) entries.add(host);
    // The model endpoint is deliberately not on this list: when the profile chooses a route, the
    // API traffic is meant to take it too, otherwise the address the API sees is still this
    // machine's. The profile's own NO_PROXY is honoured as written.
    //
    // The happy server is on it, and that is not a model host: the proxy variables live in this
    // process's environment as well, so without this entry the session's own message fetching
    // would be sent to the loopback proxy too. The proxy only speaks CONNECT or absolute-form
    // http, so those requests come back 400 and the session stops syncing. The control plane is
    // not the agent's traffic; it leaves from this machine as it always has.
    try {
        entries.add(new URL(configuration.serverUrl).hostname);
    } catch {
        // A malformed server URL leaves the list as the profile wrote it.
    }
    return [...entries].join(',');
}

function describeHop(raw: string): string {
    try {
        const url = new URL(raw);
        return `${url.hostname}:${url.port || 1080}`;
    } catch {
        return 'hop';
    }
}
