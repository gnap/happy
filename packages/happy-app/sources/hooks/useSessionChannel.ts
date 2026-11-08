import { useShallow } from 'zustand/react/shallow';
import { storage, useMachineBadgeInputs } from '@/sync/storage';
import type { SessionChannel } from '@/sync/lan/types';
import type { ChannelLinkState } from '@/sync/channels/types';
import { machineChannelIcons } from '@/sync/machinePresence';
import { normalizeChannelPriority } from '@/sync/lan/channelOrder';
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
 * `link` is the *channel's* statement about the machine, decided by the same rule the machine
 * badges use (`machineChannelIcons`), and it is deliberately not bounded by whether this session is
 * running. A channel's availability is the channel's — the relay holding the machine, the LAN
 * having seen it — and a session that has stopped says so in its own status line. Bounding the glyph
 * by the session made one stopped session paint its machine's channel grey, which read as "the
 * channel is unavailable" and was the same mixing of session state and channel state the resolver
 * no longer does.
 */
export function useSessionChannel(sessionId: string): {
    channel: SessionChannel;
    reason: ChannelReason;
    pinned: boolean;
    link: ChannelLinkState | null;
} {
    const badgeInputs = useMachineBadgeInputs();
    const machineId = storage((state) => state.sessions[sessionId]?.metadata?.machineId);
    const priority = storage(useShallow((state) => normalizeChannelPriority(state.localSettings.channelPriority)));
    return storage(useShallow((state) => {
        const { channel, reason } = sync.describeChannel(sessionId);
        // The channel's own link for this machine, merged the way a machine badge merges it: a
        // reported socket state wins, and an absent one falls back to whether the channel reaches
        // the machine at all.
        let link: ChannelLinkState | null = null;
        if (channel !== 'server' && machineId) {
            const inputs = badgeInputs(machineId);
            link = machineChannelIcons(priority, inputs.reach, inputs.capability, inputs.link)
                .find((entry) => entry.channel === channel)?.state ?? 'off';
        }
        return { channel, reason, pinned: state.channelOverride[sessionId] !== undefined, link };
    }));
}
