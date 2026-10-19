import { useShallow } from 'zustand/react/shallow';
import { storage, useMachineBadgeInputs } from '@/sync/storage';
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
 */
export function useSessionChannel(sessionId: string): {
    channel: SessionChannel;
    reason: ChannelReason;
    pinned: boolean;
    link: ChannelLinkState | null;
} {
    const badgeInputs = useMachineBadgeInputs();
    return storage(useShallow((state) => {
        const { channel, reason } = sync.describeChannel(sessionId);
        const machineId = state.sessions[sessionId]?.metadata?.machineId;
        const link = channel !== 'server' && machineId ? badgeInputs(machineId).link[channel] : null;
        return { channel, reason, pinned: state.channelOverride[sessionId] !== undefined, link };
    }));
}
