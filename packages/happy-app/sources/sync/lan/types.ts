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
    t: 'lan' | 'ipv6';
    addr: string;
    port: number;
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
    /** Only the entries written after the `since` this read was made with, when one was sent. */
    entries: LanSessionLogEntry[];
    /** Opaque position to send back as `since` on the next read. */
    cursor: string;
    /** True when `since` could not be honoured, so `entries` is the whole log, not a continuation. */
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
