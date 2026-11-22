import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { useSessionRuntimeEntry } from '@/sync/storage';
import { getSessionA2AUnreadCount } from '@/utils/sessionUtils';
import { sessionRuntimeDisplay } from '@/utils/sessionRuntimeStatus';
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
    const goal = getActiveGoal(session);
    // A want the machine stopped retrying. The row's status line says which action failed; this is
    // the mark that makes it visible in a list scanned for what is running.
    const blocked = sessionRuntimeDisplay(useSessionRuntimeEntry(session.id))?.kind === 'blocked';

    // The work a session has in flight — and what a count is made of — is the input bar's bubble,
    // not the row's. A row's job is to open the conversation, so a count here is a number with
    // nowhere to go; the goal keeps its glyph because it is a status to scan for, not a count.
    if (a2aUnread === 0 && !needsRestart && !goal && !blocked) {
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
            {/* Only the goal: the counts of running work live in the input bar's bubble. */}
            <SessionActivityBadges goal={goal} compact />
            {blocked ? (
                <Ionicons name="alert-circle" size={16} color="#FF3B30" />
            ) : null}
            {needsRestart ? (
                <Ionicons name="sync-circle-outline" size={16} color="#FF9500" />
            ) : null}
        </View>
    );
});
