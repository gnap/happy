import * as React from 'react';
import { Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useCountdown, formatCountdown } from '@/hooks/useCountdown';
import { t } from '@/text';

/**
 * One line saying how long until a moment the card already explained.
 *
 * `hideWhenDue` is for a one-shot: once the moment has passed the card is history, and a line
 * reading "due now" on a schedule that fired an hour ago says nothing true. A recurring schedule
 * never uses it — its view moves the deadline forward instead.
 */
export const CountdownLine = React.memo(function CountdownLine({
    deadline,
    hideWhenDue = false,
}: {
    deadline: number | null;
    hideWhenDue?: boolean;
}) {
    const remaining = useCountdown(deadline);
    if (remaining === null) {
        return null;
    }
    if (remaining <= 0) {
        return hideWhenDue ? null : <Text style={styles.text}>{t('tools.countdown.due')}</Text>;
    }
    return <Text style={styles.text}>{t('tools.countdown.in', { time: formatCountdown(remaining) })}</Text>;
});

const styles = StyleSheet.create((theme) => ({
    text: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        paddingVertical: 2,
    },
}));
