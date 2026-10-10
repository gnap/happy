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

/** The last set this logged, so the line appears when it changes rather than on every render. */
let lastLogged: string | null = null;

/**
 * One icon per enabled channel, highest priority first, coloured by its link state.
 *
 * Sized to be read at a glance: these sit next to the connection text in a header, and a channel
 * that is on is only worth showing if its state can be told apart from the one next to it.
 */
export const ChannelIcons = React.memo(() => {
    const links = useChannelLinks();
    // What this actually decided, said once per change. "The icon is not on screen" and "the icon
    // was never rendered" look identical from the outside, and this is the only one of the two a
    // log can settle.
    const summary = links.map(({ channel, state }) => `${channel}=${state}`).join(' ') || '(none)';
    if (summary !== lastLogged) {
        lastLogged = summary;
        // Which client this is matters as much as what it computed: the same bundle runs in a
        // browser, in the Tauri webview and on the phones, and they log identically.
        const ua = typeof navigator === 'undefined' ? null : String(navigator.userAgent ?? '');
        const origin = typeof window === 'undefined' ? '' : String(window.location?.origin ?? '');
        const client = ua === null
            ? 'native'
            : /tauri/i.test(ua) ? 'tauri' : /Version\/.*Safari/.test(ua) ? 'safari' : ua.slice(0, 40);
        console.log(`🔌 channels [${client}@${origin}]: ${summary}`);
    }
    if (links.length === 0) {
        return null;
    }
    return (
        <View style={styles.row}>
            {links.map(({ channel, state }) => (
                <Ionicons key={channel} name={CHANNEL_ICONS[channel]} size={13} color={LINK_COLORS[state]} />
            ))}
        </View>
    );
});

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginRight: 5,
    },
});
