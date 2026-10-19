import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    CHANNEL_ICONS,
    machineChannelIcons,
    type MachineCapability,
    type MachineLink,
    type MachineReach,
} from '@/sync/machinePresence';
import type { ChannelLinkState } from '@/sync/channels/types';
import { useLocalSetting } from '@/sync/storage';

const CONNECTED = '#34C759';
const DOWN = '#8E8E93';

/** The last set this logged, so the line appears when a decision changes rather than on every render. */
let lastLogged: string | null = null;

/**
 * Says which icons were drawn, and which channels were left out for not being on this machine.
 *
 * An icon that is missing and an icon that was never considered look the same on screen, and the
 * difference is exactly what a machine expected to be reachable over a channel it has not announced
 * turns on.
 */
function logDecision(
    machineId: string | undefined,
    priority: readonly string[],
    reach: MachineReach,
    capability: MachineCapability,
    icons: { channel: string; state: ChannelLinkState }[],
): void {
    const drew = icons.map((icon) => `${icon.channel}:${icon.state}`).join(' ') || '(none)';
    const reached = [reach.lan ? 'lan' : '', reach.relay ? 'relay' : '', reach.server ? 'server' : ''].filter(Boolean).join(' ') || 'none';
    const summary = `${machineId ?? '?'} | ${priority.join('>')} | drew ${drew} | capable lan=${capability.lan} relay=${capability.relay} | reach ${reached}`;
    if (summary !== lastLogged) {
        lastLogged = summary;
        console.log(`📡 machine channels: ${summary}`);
    }
}

/**
 * How each channel's link to this machine is doing: one icon per enabled channel in priority order,
 * green when its own connection is live, the theme's "in progress" colour while it is connecting,
 * and dimmed when it is not there.
 *
 * Three inputs, because they answer three different questions: `capability` says whether the icon
 * is drawn at all, `link` says what that channel's connection to this machine is doing right now
 * (a LAN socket reconnecting while reads still work is the state this used to hide), and `reach`
 * stands in where a channel holds no per-machine link to report.
 */
export const MachinePresenceBadge = React.memo(function MachinePresenceBadge({
    reach,
    capability,
    link,
    /** Which machine this is about, for the log line only — an icon's absence has to be traceable. */
    machineId,
}: {
    reach: MachineReach;
    capability: MachineCapability;
    link?: MachineLink;
    machineId?: string;
}) {
    const priority = useLocalSetting('channelPriority');
    const { theme } = useUnistyles();
    const icons = machineChannelIcons(priority, reach, capability, link);
    logDecision(machineId, priority, reach, capability, icons);

    const colorFor = (state: ChannelLinkState): { color: string; opacity: number } => {
        if (state === 'connected') {
            return { color: CONNECTED, opacity: 1 };
        }
        if (state === 'connecting') {
            return { color: theme.colors.status.connecting, opacity: 1 };
        }
        return { color: DOWN, opacity: 1 };
    };

    return (
        <View style={styles.container}>
            {icons.map(({ channel, state }) => (
                <Ionicons
                    key={channel}
                    name={CHANNEL_ICONS[channel]}
                    size={10}
                    color={colorFor(state).color}
                    style={{ opacity: colorFor(state).opacity }}
                />
            ))}
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
});
