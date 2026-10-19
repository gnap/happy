import { useShallow } from 'zustand/react/shallow';
import { storage, useMachineBadgeInputs, useSessionReach } from '@/sync/storage';
import type { SessionChannel } from '@/sync/lan/types';
import type { ChannelLinkState } from '@/sync/channels/types';
import { sync, type ChannelReason } from '@/sync/sync';

/**
 * The channel a session is on right now, derived from the same resolver the sync engine uses to
 * choose where to read and write, so what the UI shows cannot drift from what actually happens.
 * The selector re-runs on every store change (sightings, agentState, pins), which is exactly the
 * set of inputs the resolver reads.
 *
 * `link` is how that channel's own connection to the machine is doing, which is *not* the same
 * question: the resolver says the LAN can serve this session because the machine is reachable, and
 * reads over its HTTP API keep working while the push/send socket reconnects. Showing only the
 * channel let a session claim "LAN" while its messages were quietly going out over the server.
 *
 * It is bounded by whether anything is reaching the *session*, though, because the glyph is drawn
 * beside that session's status and is read as a statement about it. A machine can be on this
 * network with a live socket while a session on it is not running at all — after a reboot, every
 * session is — and the connection being up says nothing about a process that no longer exists.
 * Drawn full strength there, it put a lit channel icon next to "last seen 1 hour ago".
 */
export function useSessionChannel(sessionId: string): {
    channel: SessionChannel;
    reason: ChannelReason;
    pinned: boolean;
    link: ChannelLinkState | null;
} {
    const badgeInputs = useMachineBadgeInputs();
    const machineId = storage((state) => state.sessions[sessionId]?.metadata?.machineId);
    const reach = useSessionReach(sessionId, machineId);
    return storage(useShallow((state) => {
        const { channel, reason } = sync.describeChannel(sessionId);
        // `off` rather than null: the machine has the channel, it is simply not carrying this
        // session. Null is for a channel with no per-machine connection to report at all.
        const link = channel !== 'server' && machineId
            ? (reach.online ? badgeInputs(machineId).link[channel] : 'off')
            : null;
        return { channel, reason, pinned: state.channelOverride[sessionId] !== undefined, link };
    }));
}
