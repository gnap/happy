import type { Machine } from './storageTypes';

/**
 * How a machine is currently reachable from this device.
 *
 * Kept as three states rather than a boolean because the two reachable states are genuinely
 * different paths with different failure modes — exactly the distinction the LAN work exists to
 * make visible:
 *
 * - `server`  the Happy server reports the machine as active. This is the historical meaning of
 *             "online" and what the green dot has always meant.
 * - `lan`     the server does NOT report it as active, but the daemon is advertising itself over
 *             mDNS and we found it on this network. The machine is reachable right now even
 *             though the server thinks otherwise — the case where the server is down, or the
 *             machine's socket has dropped but its daemon is still up.
 * - `offline` neither: no server presence and nothing on the LAN.
 *
 * Deliberately NOT modelled by writing LAN discoveries into the `machines` store. `Machine.active`
 * is the server's answer, and `fetchMachines` overwrites that store wholesale; folding a local
 * observation into it would both corrupt the flag's meaning and get clobbered on the next fetch.
 * The two sources stay separate and are joined at render time.
 */
export type MachinePresence = 'server' | 'lan' | 'offline';

/**
 * Dot / label colours per state. Hardcoded rather than themed to match `utils/sessionUtils.ts`,
 * which is the closest analogue (session status colours live there, not in `theme.colors.status`).
 * `server` and `offline` reuse the exact colours already used for machines in
 * `app/(app)/machine/[id].tsx` so a machine never changes colour depending on where it is shown.
 */
export const MACHINE_PRESENCE_COLORS: Record<MachinePresence, string> = {
    server: '#34C759',
    lan: '#32ADE6',
    offline: '#999999',
};

/**
 * Resolve a machine's presence. `machine` may be null when the server has never told us about
 * this machine id at all — a LAN-only sighting still resolves to `lan` in that case, which is
 * what makes a daemon we have no server record for visible rather than silently dropped.
 */
export function resolveMachinePresence(
    machine: Machine | null | undefined,
    lanReachable: boolean
): MachinePresence {
    if (machine?.active) {
        return 'server';
    }
    if (lanReachable) {
        return 'lan';
    }
    return 'offline';
}

/** Glyph per channel: wifi for the local link, a globe for the public server. */
export const CHANNEL_ICONS = {
    lan: 'wifi',
    server: 'globe-outline',
} as const;
