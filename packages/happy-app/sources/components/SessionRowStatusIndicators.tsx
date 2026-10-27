import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { getSessionA2AUnreadCount } from '@/utils/sessionUtils';
import { getActiveGoal } from '@/utils/goalUtils';
import { SessionActivityBadges } from '@/components/SessionActivityBadges';
import { StyleSheet } from 'react-native-unistyles';

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
    const backgroundTasks = session.agentState?.backgroundTasks ?? [];

    if (a2aUnread === 0 && !needsRestart && cronCount === 0 && !goal && backgroundTasks.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
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
            {/* The goal is drawn by the badges too — as the same icon, in the same place, beside
                the counts of what else the session is running. */}
            <SessionActivityBadges tasks={backgroundTasks} goal={goal} compact />
            {needsRestart ? (
                <Ionicons name="sync-circle-outline" size={16} color="#FF9500" />
            ) : null}
        </View>
    );
});
