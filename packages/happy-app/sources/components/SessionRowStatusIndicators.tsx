import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { getSessionA2AUnreadCount } from '@/utils/sessionUtils';
import { GOAL_STATUS_ICONS, getActiveGoal } from '@/utils/goalUtils';
import { StyleSheet } from 'react-native-unistyles';
import { useSessionServedOverLan } from '@/sync/storage';
import { MACHINE_PRESENCE_COLORS } from '@/sync/machinePresence';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    badge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    badgeText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export const SessionRowStatusIndicators = React.memo(({ session, needsRestart }: { session: Session; needsRestart?: boolean }) => {
    const styles = stylesheet;
    const a2aUnread = getSessionA2AUnreadCount(session);
    const cronCount = session.agentState?.crons ? Object.keys(session.agentState.crons).length : 0;
    const goal = getActiveGoal(session);

    // Present only while the server is not serving this session and the LAN is — so it reads as
    // "you are on the fallback channel right now", not as a permanent property of the session.
    const lanServed = useSessionServedOverLan(session.id);

    if (a2aUnread === 0 && !needsRestart && cronCount === 0 && !goal && !lanServed) {
        return null;
    }

    return (
        <View style={styles.container}>
            {lanServed ? (
                <View style={styles.badge}>
                    <Ionicons name="wifi-outline" size={10} color={MACHINE_PRESENCE_COLORS.lan} />
                    <Text style={[styles.badgeText, { color: MACHINE_PRESENCE_COLORS.lan }]}>{t('status.lan')}</Text>
                </View>
            ) : null}
            {session.tasks && session.tasks.length > 0 ? (
                <View style={styles.badge}>
                    <Ionicons name="checkmark-circle-outline" size={10} color={styles.badgeText.color} />
                    <Text style={styles.badgeText}>
                        {session.tasks.filter(t => t.status === 'completed').length}/{session.tasks.length}
                    </Text>
                </View>
            ) : null}
            {a2aUnread > 0 ? (
                <View style={styles.badge}>
                    <Ionicons name="mail-unread-outline" size={10} color={styles.badgeText.color} />
                    <Text style={styles.badgeText}>{a2aUnread}</Text>
                </View>
            ) : null}
            {cronCount > 0 ? (
                <View style={styles.badge}>
                    <Ionicons name="alarm-outline" size={10} color={styles.badgeText.color} />
                    <Text style={styles.badgeText}>{cronCount}</Text>
                </View>
            ) : null}
            {goal ? (
                <Ionicons name={GOAL_STATUS_ICONS[goal.status].icon} size={16} color={GOAL_STATUS_ICONS[goal.status].color} />
            ) : null}
            {needsRestart ? (
                <Ionicons name="sync-circle-outline" size={16} color="#FF9500" />
            ) : null}
        </View>
    );
});
