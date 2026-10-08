import type { ZeroconfService } from 'expo-zeroconf';
import { isRunningInTauri } from '@/utils/platform';

/**
 * mDNS browse for the desktop (Tauri) build.
 *
 * `expo-zeroconf` is a native module, so it does not exist in the web build the desktop app runs
 * — discovery there returns nothing and the whole LAN channel is inert. The webview has no mDNS
 * API to fall back on and browsers do not expose one, so the browse runs in the Rust side
 * instead (`src-tauri/src/mdns.rs`) and the results are mapped back into `ZeroconfService`.
 *
 * Doing the mapping here rather than in the caller keeps discovery's account filter and
 * everything downstream (lanSightings, machine presence, the channel switch) byte-identical to
 * the native path — the only difference is where the browse happened.
 */

/** What `mdns_browse` returns; mirrors the fields of `ZeroconfService` we actually consume. */
type TauriMdnsService = {
    name: string;
    host: string | null;
    port: number;
    addresses: string[];
    txt: Record<string, string>;
};

/**
 * Browses via the Rust side. Returns `null` when this is not a Tauri build, or the command is
 * unavailable — as opposed to an empty array, which means the browse ran and found nothing. The
 * caller reports those two cases differently, so they must not be collapsed.
 */
export async function browseViaTauri(options: {
    /** Full service type, e.g. `_happy._tcp` — mdns-sd wants the trailing `local.` appended. */
    serviceType: string;
    timeoutMs?: number;
}): Promise<ZeroconfService[] | null> {
    if (!isRunningInTauri()) {
        return null;
    }

    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const found = await invoke<TauriMdnsService[]>('mdns_browse', {
            serviceType: options.serviceType.endsWith('.') ? options.serviceType : `${options.serviceType}.local.`,
            timeoutMs: options.timeoutMs ?? 5000,
        });

        return found.map((service) => ({
            name: service.name,
            type: options.serviceType,
            domain: 'local.',
            host: service.host ?? undefined,
            port: service.port,
            addresses: service.addresses,
            txt: service.txt,
        }));
    } catch {
        // A missing command (older binary) or a browse failure both degrade to "unavailable";
        // the caller falls back exactly as it does when the native module is absent.
        return null;
    }
}
