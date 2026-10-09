/**
 * Wire types for the CLI daemon's read-only LAN API.
 *
 * These mirror `packages/happy-cli/src/daemon/lanServer.ts` field for field. The names are
 * deliberately identical — in particular `dataEncryptionKey` is the same
 * `version(1) || box(contentKey -> account content public key)` blob the server hands out as
 * `Session.dataEncryptionKey`, so the existing unwrapping code is reused unchanged.
 */

/** Must match `LAN_PROTOCOL_VERSION` in the CLI; a mismatch means the shapes below may differ. */
export const LAN_PROTOCOL_VERSION = 1;

/** The Bonjour service type the daemon advertises. `_happy._tcp` matches lanDiscovery.ts. */
export const LAN_SERVICE_TYPE = '_happy._tcp';

/** The TCP port the daemon prefers; it falls back to an ephemeral one, which SRV reflects. */
export const LAN_DEFAULT_PORT = 55673;

/**
 * Where a machine can be reached. `t: 'lan'` is a private IPv4 address, `t: 'ipv6'` a
 * globally routable one. Published in `Machine.daemonState.p2p` by the daemon.
 */
export type LanEndpoint = {
    t: 'lan' | 'ipv6' | 'relay';
    addr: string;
    port: number;
    /** Relay only: the path segment (`/r/<tag>`) the relay routes to this machine. */
    tag?: string;
};

/**
 * How a session's traffic reaches its daemon. `lan` is a direct link found on this network,
 * `relay` is a public relay the daemon dials out to (usable when the server is down and the
 * daemon is elsewhere), and `server` is the Happy server.
 */
export type SessionChannel = 'lan' | 'relay' | 'server';

/** The two ways to reach a daemon directly; the third channel, `server`, is not a daemon route. */
export type DaemonRoute = Exclude<SessionChannel, 'server'>;

/** A relay route that answered a probe recently: the daemon is registered and reachable through it. */
export type RelaySighting = {
    machineId: string;
    baseUrl: string;
    at: number;
};

/** A public relay route to a machine, learned from its published endpoints. */
export type RelayEndpoint = {
    machineId: string;
    /** `https://host[:port]/r/<tag>` — usable anywhere a LAN base URL is. */
    baseUrl: string;
    /** When the daemon published it; the cache is a hint, not a lease. */
    at: number;
};

/** The `daemonState.p2p` payload, as published by `lanEndpoints.ts`. */
export type PublishedLanEndpoints = {
    v: number;
    endpoints: LanEndpoint[];
    at: number;
};

export type LanSessionSummary = {
    happySessionId: string;
    directory: string;
    agent: string;
    startedBy: string;
    isAlive: boolean;
    lastHeartbeat?: number;
};

/**
 * One entry of the daemon's local message log. `c` is the ciphertext exactly as it crossed the
 * wire, so it decrypts with the session key and nothing else. `dir` is 'in' or 'out'.
 */
export type LanSessionLogEntry = {
    id: string;
    localId: string | null;
    dir: 'in' | 'out';
    at: number;
    c: string;
};

export type LanHistory = {
    tag: string;
    dataEncryptionKey: string;
    /** The page's entries, oldest first, whichever direction it was read in. */
    entries: LanSessionLogEntry[];
    /** Boundary after the last entry: send back as `since` to follow the log forward. */
    cursor: string;
    /** Boundary before the first entry: send back as `before` to read older. */
    older: string;
    /** The log continues past this page, so a reader's page was cut short rather than the log ending. */
    hasNewer: boolean;
    /** The log continues before this page — "there is older history", which is what the UI gates on. */
    hasOlder: boolean;
    /** True when `since` could not be honoured, so `entries` is the log from its start. */
    reset: boolean;
};

export type LanIdentity = {
    v: number;
    machineId: string;
    accountFingerprint: string;
    hostname: string;
    platform: string;
};

/**
 * A machine seen on the local network, with the time it was seen.
 *
 * This is the app's record of a *local observation*, kept separate from the `Machine` records the
 * server hands out — see `sync/machinePresence.ts` for why the two are not merged.
 */
export type LanSighting = {
    machineId: string;
    host: string;
    port: number;
    baseUrl: string;
    /** When this sighting was recorded. Used to expire entries a later scan no longer reports. */
    at: number;
};

/** A daemon found by browsing `_happy._tcp`, with its TXT record already decoded. */
export type DiscoveredMachine = {
    /** The Bonjour instance name, e.g. `happy-<machineId>`. */
    serviceName: string;
    machineId: string;
    accountFingerprint: string;
    /** Protocol version from TXT, or null when the record is absent or unparsable. */
    protocolVersion: number | null;
    host: string;
    port: number;
    /** Base URL for the LAN API. */
    baseUrl: string;
};
