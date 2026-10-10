import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { CHANNEL_ICONS, machineChannelIcons, type MachineCapability, type MachineReach } from '@/sync/machinePresence';
import { useLocalSetting } from '@/sync/storage';

const CONNECTED = '#34C759';
const DOWN = '#8E8E93';

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
}: {
    reach: MachineReach;
    capability: MachineCapability;
}) {
    const priority = useLocalSetting('channelPriority');
    const icons = machineChannelIcons(priority, reach, capability);

    return (
        <View style={styles.container}>
            {icons.map(({ channel, up }) => (
                <Ionicons key={channel} name={CHANNEL_ICONS[channel]} size={11} color={up ? CONNECTED : DOWN} />
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
