import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { CHANNEL_ICONS, machineChannelIcons, type MachineCapability, type MachineReach } from '@/sync/machinePresence';
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
    icons: { channel: string; up: boolean }[],
): void {
    const drew = icons.map((icon) => `${icon.channel}:${icon.up ? 'up' : 'down'}`).join(' ') || '(none)';
    const reached = [reach.lan ? 'lan' : '', reach.relay ? 'relay' : '', reach.server ? 'server' : ''].filter(Boolean).join(' ') || 'none';
    const summary = `${machineId ?? '?'} | ${priority.join('>')} | drew ${drew} | capable lan=${capability.lan} relay=${capability.relay} | reach ${reached}`;
    if (summary !== lastLogged) {
        lastLogged = summary;
        console.log(`📡 machine channels: ${summary}`);
    }
}

/**
 * How a machine is reachable: one icon per enabled channel in priority order, green when that
 * channel reaches the machine now, grey when it does not.
 *
 * Two inputs rather than one, because a machine can be reachable over several channels at once and
 * a single "how is it reachable" answer can only name one of them: `reach` says which channels are
 * getting through right now, `capability` says which of them this machine is on at all. Only
 * channels switched on in the priority setting appear, the LAN icon only once the machine has been
 * seen on this network, and the relay icon only when the relay itself vouches for the machine.
 */
export const MachinePresenceBadge = React.memo(function MachinePresenceBadge({
    reach,
    capability,
    /** Which machine this is about, for the log line only — an icon's absence has to be traceable. */
    machineId,
}: {
    reach: MachineReach;
    capability: MachineCapability;
    machineId?: string;
}) {
    const priority = useLocalSetting('channelPriority');
    const icons = machineChannelIcons(priority, reach, capability);
    logDecision(machineId, priority, reach, capability, icons);

    return (
        <View style={styles.container}>
            {icons.map(({ channel, up }) => (
                <Ionicons key={channel} name={CHANNEL_ICONS[channel]} size={13} color={up ? CONNECTED : DOWN} />
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
