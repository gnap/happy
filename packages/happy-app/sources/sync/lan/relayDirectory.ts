import type { LanSessionSummary } from './types';

/**
 * One machine as the relay describes it.
 *
 * The relay holds a connection to every daemon that dialled in, and each daemon publishes its own
 * session summary — so this is the relay's answer to "which machines, and what is on them", in the
 * same shape the daemon's `GET /lan/sessions` returns. The App does not have to ask any machine, and
 * does not have to keep a connection to one to know it is there.
 */
export type RelayDirectoryEntry = {
    /**
     * Which machine this is, resolved locally.
     *
     * The relay names machines by tag — a hash of a key it never sees — and this device is the one
     * that knows which of its machines hashes to which tag, because it derives the tag from the
     * machine key it already holds. A tag with no match is not invented into a machine id: it is
     * reported separately, as a tag this device cannot name.
     */
    machineId: string;
    /** The relay's own name for the machine, kept for display and for opening streams to it. */
    tag: string;
    /** What the machine published. Empty for a daemon running a CLI that predates the directory. */
    sessions: LanSessionSummary[];
    /** When this answer was received. */
    at: number;
};
