import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { discoverMachines, accountFingerprintOf } from '@/sync/lan/discovery';

/**
 * Periodically browses the LAN for Happy daemons and records what it finds.
 *
 * This is what gives the app a reachability signal that does not come from the Happy server: a
 * machine the server reports as inactive can still be sitting on the same Wi-Fi. Results land in
 * `storage.lanSightings` and are joined with server machine state in `useMachinePresenceMap`.
 *
 * Mount once, high in the authenticated app — this owns a repeating mDNS browse, so running it
 * from a screen would restart the cadence on every navigation.
 *
 * Cadence is deliberately modest: each browse occupies the multicast socket for roughly its
 * timeout, so a 4s browse every 30s keeps the duty cycle near 13% while still recovering from a
 * missed announcement. The `lanSightings` TTL is 3× the interval, so one lost scan never flickers
 * a machine between reachable and offline.
 *
 * Scanning is suspended unless the app is foregrounded: iOS will not deliver multicast to a
 * backgrounded app, and waking to scan would just burn battery for an empty result.
 */
const SCAN_INTERVAL_MS = 30_000;
const SCAN_TIMEOUT_MS = 4_000;

export function useLanScanner(): void {
    React.useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        let appState: AppStateStatus = AppState.currentState;
        // Logged only on change: one line per transition, not one per 30s tick. Starts as null so
        // the very first scan always logs — including the "found nothing" case, which is the one
        // most worth seeing (a sentinel of '' would compare equal to an empty result and stay silent).
        let lastLoggedIds: string | null = null;
        let warnedNotSignedIn = false;
        let warnedUnavailable = false;

        const scanOnce = async () => {
            // `sync.encryption` is only set once the user is signed in and the master secret has
            // been derived; the account public key is the input the discovery filter needs.
            const accountPublicKey = sync.encryption?.contentDataKey;
            // Switched off in the channel priority setting: do not browse at all.
            if (!storage.getState().localSettings.channelPriority.includes('lan')) {
                return;
            }
            if (!accountPublicKey || cancelled) {
                // Before sign-in there is no account key, so the scan cannot be filtered to this
                // account. Say so once instead of looking like a scanner that finds nothing.
                if (!accountPublicKey && !warnedNotSignedIn) {
                    warnedNotSignedIn = true;
                    console.log('📡 LAN scanner: waiting for sign-in (no account key yet)');
                }
                return;
            }
            try {
                if (lastLoggedIds === null) {
                    // One-time: the fingerprint this device filters by. Compare against the
                    // daemon's advertised TXT `accountFingerprint` when discoveries are rejected.
                    console.log(`📡 LAN scanner: this account's fingerprint is ${await accountFingerprintOf(accountPublicKey)}`);
                }
                let rawCount = 0;
                const found = await discoverMachines({
                    accountPublicKey,
                    timeoutMs: SCAN_TIMEOUT_MS,
                    onRawCount: (count) => { rawCount = count; },
                    onUnavailable: () => {
                        if (!warnedUnavailable) {
                            warnedUnavailable = true;
                            console.log('📡 LAN scanner: zeroconf unavailable — not scanning');
                        }
                    },
                });
                if (cancelled) {
                    return;
                }
                // Keyed on the raw count too, so "the browse stopped seeing anything" is visible
                // even while the account-filtered result stays empty.
                const key = `${rawCount}|${found.map((m) => m.machineId).sort().join(',')}`;
                if (key !== lastLoggedIds) {
                    lastLoggedIds = key;
                    const detail = found.map((m) => `${m.machineId.slice(0, 8)}@${m.host}:${m.port}`).join(', ');
                    console.log(
                        `📡 LAN scan: ${rawCount} advertised, ${found.length} for this account` + (detail ? ` — ${detail}` : '')
                    );
                }
                const at = Date.now();
                storage.getState().applyLanSightings(
                    found.map((machine) => ({
                        machineId: machine.machineId,
                        host: machine.host,
                        port: machine.port,
                        baseUrl: machine.baseUrl,
                        at,
                    }))
                );
            } catch {
                // A failed browse is routine (radio state, permissions, no daemons). The TTL keeps
                // the previous sightings alive; the next tick retries.
            }
        };

        const start = () => {
            if (timer !== null) {
                return;
            }
            void scanOnce();
            timer = setInterval(() => { void scanOnce(); }, SCAN_INTERVAL_MS);
        };

        const stop = () => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };

        if (appState === 'active') {
            start();
        }

        const subscription = AppState.addEventListener('change', (next) => {
            appState = next;
            if (next === 'active') {
                start();
            } else {
                stop();
            }
        });

        return () => {
            cancelled = true;
            stop();
            subscription.remove();
        };
    }, []);
}
