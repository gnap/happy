import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { getSessionA2AUnreadCount } from '@/utils/sessionUtils';
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
    const ctxPct = session.metadata?.contextUsage?.pct;

    let todoLabel: string | null = null;
    if (session.todos && session.todos.length > 0) {
        const total = session.todos.length;
        const completed = session.todos.filter((t) => t.status === 'completed').length;
        if (completed < total) {
            todoLabel = `${completed}/${total}`;
        }
    }

    const ctxColor = ctxPct !== undefined && ctxPct >= 90 ? '#FF3B30'
        : ctxPct !== undefined && ctxPct >= 70 ? '#FF9500'
        : '#34C759';

    if (a2aUnread === 0 && !todoLabel && !needsRestart && cronCount === 0 && ctxPct === undefined) {
        return null;
    }

    return (
        <View style={styles.container}>
            {todoLabel ? (
                <View style={styles.badge}>
                    <Ionicons name="bulb-outline" size={10} color={styles.badgeText.color} />
                    <Text style={styles.badgeText}>{todoLabel}</Text>
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
            {ctxPct !== undefined ? (
                <View style={styles.badge}>
                    <Ionicons name="layers-outline" size={10} color={ctxColor} />
                    <Text style={[styles.badgeText, { color: ctxColor }]}>{Math.round(ctxPct)}%</Text>
                </View>
            ) : null}
            {needsRestart ? (
                <Ionicons name="sync-circle-outline" size={16} color="#FF9500" />
            ) : null}
        </View>
    );
});
