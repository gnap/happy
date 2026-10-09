import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { storage } from '@/sync/storage';
import { probeRelay } from '@/sync/lan/relayProbe';

/**
 * Periodically asks each cached relay route whether its daemon answers, and records what works.
 *
 * This is the relay's counterpart of `useLanScanner`: a reachability signal that does not come
 * from the Happy server. The routes themselves are cached from the server once, but whether they
 * work *now* is learned here, so a cold start with the server down still finds out which machines
 * can be reached through the relay.
 *
 * Same cadence and TTL discipline as the LAN scanner (30s interval, sightings live 3x that), and
 * the same foreground-only rule: a backgrounded app has no use for the answer.
 */
const PROBE_INTERVAL_MS = 30_000;

export function useRelayProber(): void {
    React.useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        let appState: AppStateStatus = AppState.currentState;
        let lastLogged: string | null = null;

        const probeOnce = async () => {
            const endpoints = Object.values(storage.getState().relayEndpoints);
            // Switched off in the channel priority setting: send nothing to the relay.
            if (endpoints.length === 0 || !storage.getState().localSettings.channelPriority.includes('relay')) {
                return;
            }
            const results = await Promise.all(endpoints.map(async (endpoint) => ({
                endpoint,
                ok: await probeRelay(endpoint.baseUrl),
            })));
            if (cancelled) {
                return;
            }
            const at = Date.now();
            const reachable = results.filter((r) => r.ok);
            const key = reachable.map((r) => r.endpoint.machineId).sort().join(',');
            if (key !== lastLogged) {
                lastLogged = key;
                console.log(`🔁 relay probe: ${reachable.length}/${endpoints.length} reachable` +
                    (key ? ` — ${reachable.map((r) => r.endpoint.machineId.slice(0, 8)).join(', ')}` : ''));
            }
            storage.getState().applyRelaySightings(reachable.map((r) => ({
                machineId: r.endpoint.machineId,
                baseUrl: r.endpoint.baseUrl,
                at,
            })));
        };

        const start = () => {
            if (timer !== null) {
                return;
            }
            void probeOnce();
            timer = setInterval(() => { void probeOnce(); }, PROBE_INTERVAL_MS);
        };
        const stop = () => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };

        // A route learned after startup, or the server dropping, should not wait a full interval:
        // the second is exactly when the answer decides which channel a session is on.
        const unsubscribe = storage.subscribe((state, previous) => {
            if ((state.relayEndpoints !== previous.relayEndpoints || state.socketStatus !== previous.socketStatus) && timer !== null) {
                void probeOnce();
            }
        });

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
            unsubscribe();
            subscription.remove();
        };
    }, []);
}
