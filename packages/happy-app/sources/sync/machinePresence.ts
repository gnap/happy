import type { SessionChannel } from './lan/types';
import type { ChannelDriver } from './channels/types';

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
 * - `relay`   neither of the above, but the daemon answers through its public relay: reachable from
 *             anywhere, which is what the relay is for.
 * - `offline` none of them.
 *
 * Deliberately NOT modelled by writing LAN discoveries into the `machines` store. `Machine.active`
 * is the server's answer, and `fetchMachines` overwrites that store wholesale; folding a local
 * observation into it would both corrupt the flag's meaning and get clobbered on the next fetch.
 * The two sources stay separate and are joined at render time.
 */
export type MachinePresence = 'server' | 'lan' | 'relay' | 'offline';

/**
 * Dot / label colours per state. Hardcoded rather than themed to match `utils/sessionUtils.ts`,
 * which is the closest analogue (session status colours live there, not in `theme.colors.status`).
 * `server` and `offline` reuse the exact colours already used for machines in
 * `app/(app)/machine/[id].tsx` so a machine never changes colour depending on where it is shown.
 */
export const MACHINE_PRESENCE_COLORS: Record<MachinePresence, string> = {
    server: '#34C759',
    lan: '#32ADE6',
    relay: '#AF52DE',
    offline: '#999999',
};

/**
 * Resolve a machine's presence, from what the channels say about it.
 *
 * The first channel — in the order this device prefers them — that reports the machine *alive* is
 * the answer. Alive rather than reachable, because that is what the dot has always meant: the
 * server can still serve a machine's sessions after the machine itself has gone, so a machine that
 * stopped would read as green if reachability were the question.
 *
 * Which channels are asked, and in what order, comes from the drivers' own priority: this used to
 * be decided here from the priority setting, while the header and the resolver decided it
 * elsewhere, and the three disagreed about a machine with a live socket and an expired sighting.
 */
export function resolveMachinePresence(
    drivers: readonly ChannelDriver[],
    machineId: string,
    now: number = Date.now(),
): MachinePresence {
    for (const driver of drivers) {
        if (driver.machine(machineId, now)?.alive === true) {
            // The driver's channel is one of the three presence states, by construction.
            return driver.channel as MachinePresence;
        }
    }
    return 'offline';
}

/**
 * Glyph per channel: wifi for the local link, two arrows for the relay, a globe for the public
 * server.
 *
 * Two arrows are what a relay *is* — traffic leaves one way and comes back the other, through
 * something in the middle — and `swap-horizontal-sharp` is the only cut of that idea that survives
 * where these are drawn: 10–11px, on a header that is near-black in the dark theme.
 *
 * Cut, not concept, is what went wrong twice here. Ionicons draws the same shape in three weights
 * and the plain ones are hairlines: at that size `swap-horizontal` and `repeat` are a smudge, which
 * reads as a channel that is not there rather than one that is not connected. `-sharp` is the solid
 * cut, and so are `wifi` and `globe`. (Rendered side by side at 10px to settle it rather than
 * guessed at: the hairlines blur into a dot, the solid cuts do not.)
 */
export const CHANNEL_ICONS = {
    lan: 'wifi',
    relay: 'swap-horizontal-sharp',
    server: 'globe',
} as const;

/**
 * Whether a channel can reach the machine *now*, and whether it is one the machine can be reached
 * over at all.
 *
 * Two separate questions, and conflating them is what made every relay icon grey: `MachinePresence`
 * is a *single* answer — server, else lan, else relay — so colouring the relay icon by
 * `presence === 'relay'` meant a machine that was online through the server could never show a
 * working relay, however reachable it was over one. Each channel answers for itself here.
 */
export type MachineReach = {
    /** The server reports the machine active. */
    server: boolean;
    /** This device has seen the machine on its network — a sighting, or a live connection to it. */
    lan: boolean;
    /** The relay is holding the machine: it dialled in and the relay said so. */
    relay: boolean;
};

/** Whether a channel is one this machine can be reached over at all, beyond being switched on. */
export type MachineCapability = {
    /** Undefined when the App has never seen the machine anywhere; only a sighting justifies the icon. */
    lan: boolean;
    /**
     * A relay route the machine itself published, or the relay holding it.
     *
     * A tag derived locally from the machine key is *not* this: every machine has one, and it says
     * nothing about whether its daemon runs a relay client. That is why hosts which have never
     * published a route grew a relay icon they had not earned.
     */
    relay: boolean;
};

/**
 * What a machine's per-channel glyphs should show.
 *
 * Built here rather than at each call site. Both callers built it inline and disagreed about the
 * server term — one read the machine presence, the other the server's own active flag — and neither
 * counted a live socket, so a machine this App was holding open over the LAN showed grey because a
 * browse had been missed. One question, one place.
 */
export function machineBadgeInputs(
    drivers: readonly ChannelDriver[],
    machineId: string,
    now: number = Date.now(),
): { reach: MachineReach; capability: MachineCapability } {
    const reach: MachineReach = { server: false, lan: false, relay: false };
    const capability: MachineCapability = { lan: false, relay: false };
    for (const driver of drivers) {
        if (driver.channel === 'server') {
            reach.server = driver.machine(machineId, now)?.alive === true;
            continue;
        }
        // Reaching it *now* is the colour; having it at all is whether the glyph is drawn.
        reach[driver.channel] = driver.machine(machineId, now)?.alive === true;
        capability[driver.channel] = driver.capable(machineId);
    }
    return { reach, capability };
}

export function machineChannelIcons(
    priority: readonly SessionChannel[],
    reach: MachineReach,
    capability: MachineCapability,
): { channel: SessionChannel; up: boolean }[] {
    return priority.flatMap((channel): { channel: SessionChannel; up: boolean }[] => {
        if (channel === 'server') {
            // Always drawn while switched on: a server that does not report the machine is still a
            // channel the App could use, so grey is the honest colour rather than absent.
            return [{ channel, up: reach.server }];
        }
        if (channel === 'lan') {
            return capability.lan ? [{ channel, up: reach.lan }] : [];
        }
        return capability.relay ? [{ channel, up: reach.relay }] : [];
    });
}

