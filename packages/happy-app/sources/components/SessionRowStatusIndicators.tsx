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

export const SessionRowStatusIndicators = React.memo(({ session }: { session: Session }) => {
    const styles = stylesheet;
    const a2aUnread = getSessionA2AUnreadCount(session);

    let todoLabel: string | null = null;
    if (session.todos && session.todos.length > 0) {
        const total = session.todos.length;
        const completed = session.todos.filter((t) => t.status === 'completed').length;
        if (completed < total) {
            todoLabel = `${completed}/${total}`;
        }
    }

    if (a2aUnread === 0 && !todoLabel) {
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
            {a2aUnread > 0 ? (
                <View style={styles.badge}>
                    <Ionicons name="mail-unread-outline" size={10} color={styles.badgeText.color} />
                    <Text style={styles.badgeText}>{a2aUnread}</Text>
                </View>
            ) : null}
        </View>
    );
});
