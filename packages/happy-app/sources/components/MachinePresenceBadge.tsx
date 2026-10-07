import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { StatusDot } from './StatusDot';
import { Typography } from '@/constants/Typography';
import { MACHINE_PRESENCE_COLORS, type MachinePresence } from '@/sync/machinePresence';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';

/**
 * How a machine is reachable, in words rather than only a colour.
 *
 * Deliberately a label and not just a dot: `server` and `lan` are different routes to the same
 * machine, and a lone colour makes the reader guess which. The two are also not mutually
 * exclusive — a machine that the server reports online can still be sitting on the same Wi-Fi —
 * so a server-online machine that is also LAN-reachable reads `online · LAN`, which is the pair of
 * facts worth knowing: it is connected now, and it can still be reached if the server goes away.
 */
export const MachinePresenceBadge = React.memo(function MachinePresenceBadge({
    presence,
    lanReachable,
}: {
    presence: MachinePresence;
    lanReachable: boolean;
}) {
    const styles = stylesheet;
    const label = presence === 'server'
        ? (lanReachable ? `${t('status.online')} · ${t('status.lan')}` : t('status.online'))
        : presence === 'lan'
            ? t('status.lan')
            : t('status.offline');

    return (
        <View style={styles.container}>
            <StatusDot color={MACHINE_PRESENCE_COLORS[presence]} />
            <Text style={styles.label} numberOfLines={1}>{label}</Text>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    label: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
