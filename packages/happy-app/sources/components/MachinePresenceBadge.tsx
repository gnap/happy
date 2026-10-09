import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { CHANNEL_ICONS, type MachinePresence } from '@/sync/machinePresence';
import type { SessionChannel } from '@/sync/lan/types';
import { useLocalSetting } from '@/sync/storage';

const CONNECTED = '#34C759';
const DOWN = '#8E8E93';

/**
 * How a machine is reachable: one icon per enabled channel in priority order, green when that
 * channel reaches the machine now, grey when it does not. LAN is hidden unless the machine is
 * currently seen on the network, and the relay is hidden unless the machine published a route.
 */
export const MachinePresenceBadge = React.memo(function MachinePresenceBadge({
    presence,
    lanReachable,
    relayCapable = false,
}: {
    presence: MachinePresence;
    lanReachable: boolean;
    relayCapable?: boolean;
}) {
    const priority = useLocalSetting('channelPriority');
    const icons = priority.flatMap((channel): { channel: SessionChannel; up: boolean }[] => {
        if (channel === 'server') {
            return [{ channel, up: presence === 'server' }];
        }
        if (channel === 'lan') {
            return lanReachable ? [{ channel, up: true }] : [];
        }
        return relayCapable || presence === 'relay' ? [{ channel, up: presence === 'relay' || relayCapable }] : [];
    });

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
