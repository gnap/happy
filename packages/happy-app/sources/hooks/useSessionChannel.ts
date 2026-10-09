import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/storage';
import type { SessionChannel } from '@/sync/lan/types';
import { sync, type ChannelReason } from '@/sync/sync';

/**
 * The channel a session is on right now, derived from the same resolver the sync engine uses to
 * choose where to read and write, so what the UI shows cannot drift from what actually happens.
 * The selector re-runs on every store change (sightings, agentState, pins), which is exactly the
 * set of inputs the resolver reads.
 */
export function useSessionChannel(sessionId: string): {
    channel: SessionChannel;
    reason: ChannelReason;
    pinned: boolean;
} {
    return storage(useShallow((state) => {
        const { channel, reason } = sync.describeChannel(sessionId);
        return { channel, reason, pinned: state.channelOverride[sessionId] !== undefined };
    }));
}
