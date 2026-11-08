import type { Machine } from '@/sync/storageTypes';
import type { MachinePresence } from '@/sync/machinePresence';

/**
 * Whether the server is holding a connection to this machine's daemon.
 *
 * The server's own flag, and the right question for exactly one thing: **spawning**. A spawn is an
 * RPC the server forwards to the daemon, so it needs the daemon to be connected to the server — and
 * this is the only thing that says so.
 *
 * It is *not* the answer to "is this machine online", which is what it used to be read as. A machine
 * this device is reaching over the LAN or the relay is online while the server has no connection to
 * it at all — which is the whole reason those channels exist — so anything drawing a status, a dot
 * or a sort order wants `machineIsReachable` over the channels instead.
 */
export function machineConnectedToServer(machine: Machine): boolean {
    // The flag directly, no timeout checks: the server drops it when the connection goes.
    return machine.active;
}

/**
 * Whether anything is reaching this machine right now, from what the channels say.
 *
 * The display question, and deliberately not `machineConnectedToServer`: a machine this device is
 * reading over the LAN is online even when the server has not heard from it.
 */
export function machineIsReachable(presence: MachinePresence): boolean {
    return presence !== 'offline';
}
