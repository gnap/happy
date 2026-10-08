/**
 * Discovers CLI daemons on the local network via Bonjour/mDNS.
 *
 * This is the LAN half of the availability story and is deliberately independent of the Happy
 * server: browsing works with the server down (and even with the account never having been
 * online from this device). The server-path alternative — reading cached endpoints out of
 * `Machine.daemonState.p2p` — serves the *cross-network* case, where the address published is
 * meant to be reachable from elsewhere; it is not a substitute for LAN discovery, because it
 * requires the server to have been reachable at least once to prime the cache.
 *
 * The TXT record carries identity only (`v`, `machineId`, `accountFingerprint`), so filtering to
 * this account happens without probing any host: the fingerprint is derived locally from the
 * account content keypair and compared against the advertised value.
 */

// Type-only, so this import is erased at runtime and does not evaluate the module. The value
// import is deliberately deferred to `discoverMachines` — see the comment there.
import type { ZeroconfService } from 'expo-zeroconf';
import { hmac_sha256 } from '@/encryption/hmac_sha256';
import { encodeHex } from '@/encryption/hex';
import { encodeUTF8 } from '@/encryption/text';
import { LAN_SERVICE_TYPE, LAN_PROTOCOL_VERSION, type DiscoveredMachine } from './types';
import { browseViaTauri } from './tauriDiscovery';

/**
 * Non-secret, stable fingerprint of the account — must equal `accountFingerprintOf` in
 * `packages/happy-cli/src/daemon/lanServer.ts` byte for byte, or the filter below silently
 * matches nothing.
 */
export async function accountFingerprintOf(accountPublicKey: Uint8Array): Promise<string> {
    const mac = await hmac_sha256(encodeUTF8('happy-lan-account-fingerprint'), accountPublicKey);
    // Lowercase: the CLI derives this with Node's `digest('hex')`, which is lowercase, while this
    // app's encodeHex emits uppercase. Without normalising, the two never compare equal and every
    // discovery is silently filtered out.
    return encodeHex(mac).slice(0, 16).toLowerCase();
}

/** Bonjour hostnames arrive fully qualified, e.g. `my-mac.local.`; the trailing dot breaks URLs. */
function normalizeHost(host: string): string {
    return host.endsWith('.') ? host.slice(0, -1) : host;
}

function toDiscoveredMachine(service: ZeroconfService): DiscoveredMachine | null {
    const txt = service.txt ?? {};
    const machineId = txt.machineId;
    const host = service.host ? normalizeHost(service.host) : service.addresses?.[0];
    const port = service.port;

    // A record without identity or a resolved address is not usable; skip rather than guess.
    if (!machineId || !host || !port) {
        return null;
    }

    const parsedVersion = Number(txt.v);

    return {
        serviceName: service.name,
        machineId,
        accountFingerprint: txt.accountFingerprint ?? '',
        protocolVersion: Number.isFinite(parsedVersion) ? parsedVersion : null,
        host,
        port,
        baseUrl: `http://${host}:${port}`,
    };
}

/**
 * Browses for `_happy._tcp` and returns the daemons that belong to `accountPublicKey`.
 *
 * Never throws for environmental reasons: a missing native module or a browse that finds
 * nothing both surface as an empty list, so callers can treat "no machines" and "discovery
 * unavailable" the same way when deciding whether to fall back.
 */
export async function discoverMachines(options: {
    /** The account content public key — the same one used to unwrap session keys. */
    accountPublicKey: Uint8Array;
    /** How long to browse before giving up. mDNS needs a moment; 5s is the module default. */
    timeoutMs?: number;
    /**
     * Called with how many services the browse actually saw, before the account filter runs.
     * Lets a caller distinguish "nothing is advertising" (network, or the local-network
     * permission was denied, in which case a browse silently returns zero) from "something is
     * advertising but it is not this account".
     */
    onRawCount?: (count: number) => void;
    /** Called when discovery cannot run at all (no native module), as opposed to finding nothing. */
    onUnavailable?: () => void;
}): Promise<DiscoveredMachine[]> {
    const expectedFingerprint = await accountFingerprintOf(options.accountPublicKey);

    // Two browse backends: `expo-zeroconf` on iOS/Android, the Rust side on desktop. The Tauri
    // probe is a cheap synchronous flag when it does not apply, so trying it first costs nothing
    // on mobile. Both produce the same `ZeroconfService` shape past this point.
    const viaTauri = await browseViaTauri({
        serviceType: LAN_SERVICE_TYPE,
        timeoutMs: options.timeoutMs,
    });

    let services: ZeroconfService[];
    if (viaTauri !== null) {
        services = viaTauri;
    } else {
        // Resolved lazily rather than at module scope. `expo-zeroconf` calls `requireNativeModule`
        // during its own first evaluation and caches the result in a module-level `isAvailable`
        // constant, swallowing any throw. This module is reachable from the app's root layout, so a
        // top-level import can be evaluated before the native module registry is populated — in which
        // case `isAvailable` latches to false for the entire run and discovery silently never works.
        // Importing at scan time makes that outcome deterministic instead of a startup race.
        let zeroconf: typeof import('expo-zeroconf');
        try {
            zeroconf = await import('expo-zeroconf');
        } catch {
            options.onUnavailable?.();
            return [];
        }
        if (!zeroconf.isAvailable) {
            options.onUnavailable?.();
            return [];
        }
        try {
            services = await zeroconf.scan(LAN_SERVICE_TYPE, {
                timeoutMs: options.timeoutMs ?? 5000,
                autoResolve: true,
            });
        } catch {
            // A failed browse is not an error worth propagating — the caller retries or falls back.
            options.onRawCount?.(0);
            return [];
        }
    }
    options.onRawCount?.(services.length);

    return services
        .map(toDiscoveredMachine)
        .filter((machine): machine is DiscoveredMachine => machine !== null)
        .filter((machine) => machine.accountFingerprint === expectedFingerprint)
        .filter((machine) => machine.protocolVersion === null || machine.protocolVersion === LAN_PROTOCOL_VERSION);
}
