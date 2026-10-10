import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useChannelLinks, type ChannelLinkState } from '@/sync/storage';
import { CHANNEL_ICONS } from '@/sync/machinePresence';

/**
 * The colour of each link state, from the theme rather than written down here.
 *
 * These sit on the header, whose background is near-black in the dark theme, and a hardcoded mid
 * grey is a speck on it — a channel that is not reaching anything would read as a channel that is
 * not there. The hues stay the ones the states were asked for; only their values follow the theme.
 */
function linkColor(
    state: ChannelLinkState,
    theme: { colors: { status: Record<string, string>; header: { tint: string } } },
): { color: string; opacity: number } {
    if (state === 'connected') {
        return { color: theme.colors.status.connected, opacity: 1 };
    }
    if (state === 'connecting') {
        // White in the dark theme, blue in the light one: the theme already knows what "in
        // progress" looks like against its own header.
        return { color: theme.colors.status.connecting, opacity: 1 };
    }
    // The header's own foreground, dimmed. A fixed grey is a different thing against a white
    // header than against a near-black one — and against the dark one it is a speck, which reads
    // as an icon that is not there rather than one that is not connected.
    return { color: theme.colors.header.tint, opacity: 0.45 };
}

/** The last set this logged, so the line appears when it changes rather than on every render. */
let lastLogged: string | null = null;

/**
 * One icon per enabled channel, highest priority first, coloured by its link state.
 *
 * It says what it decided, once per change. "The icon is not on screen" and "the icon was never
 * rendered" look identical from the outside, and this is the one of the two a log can settle — as
 * long as it also says *which* client, since the same bundle runs in a browser, a webview and on
 * the phones and they log identically.
 */
export const ChannelIcons = React.memo(() => {
    const links = useChannelLinks();
    const { theme } = useUnistyles();
    const summary = links.map(({ channel, state }) => `${channel}=${state}`).join(' ') || '(none)';
    if (summary !== lastLogged) {
        lastLogged = summary;
        const ua = typeof navigator === 'undefined' ? null : String(navigator.userAgent ?? '');
        const origin = typeof window === 'undefined' ? '' : String(window.location?.origin ?? '');
        const client = ua === null ? 'native' : /Version\/.*Safari/.test(ua) ? 'safari' : ua.slice(0, 40);
        console.log(`🔌 channels [${client}@${origin}]${theme.dark ? ' dark' : ''}: ${summary}`);
    }
    if (links.length === 0) {
        return null;
    }
    return (
        <View style={styles.row}>
            {links.map(({ channel, state }) => (
                <Ionicons
                    key={channel}
                    name={CHANNEL_ICONS[channel]}
                    size={10}
                    color={linkColor(state, theme).color}
                    style={{ opacity: linkColor(state, theme).opacity }}
                />
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
