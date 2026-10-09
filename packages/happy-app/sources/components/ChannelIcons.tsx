import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useChannelLinks, type ChannelLinkState } from '@/sync/storage';
import { CHANNEL_ICONS } from '@/sync/machinePresence';

const LINK_COLORS: Record<ChannelLinkState, string> = {
    connected: '#34C759',
    connecting: '#007AFF',
    disconnected: '#8E8E93',
};

/** One icon per enabled channel, highest priority first, coloured by its link state. */
export const ChannelIcons = React.memo(() => {
    const links = useChannelLinks();
    if (links.length === 0) {
        return null;
    }
    return (
        <View style={styles.row}>
            {links.map(({ channel, state }) => (
                <Ionicons key={channel} name={CHANNEL_ICONS[channel]} size={10} color={LINK_COLORS[state]} />
            ))}
        </View>
    );
});

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginRight: 4,
    },
});
