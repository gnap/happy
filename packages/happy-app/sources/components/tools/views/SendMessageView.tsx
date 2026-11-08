import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { t } from '@/text';
import { ToolViewProps } from './_all';
import { sendMessageBody, sendMessageOutcome, sendMessageRecipient } from '../messageTools';

/**
 * A message one session sent to another, in full.
 *
 * The card in the transcript says who it went to and how it ended; this is the page you open to
 * read what was actually said. The outcome is repeated here because the card's word for it ("sent")
 * is the thing a reader comes back to check, and the failure reason is left to the error box the
 * tool view draws underneath — one statement of a failure, not two.
 */
export const SendMessageView = React.memo<ToolViewProps>(({ tool }) => {
    const { theme } = useUnistyles();
    const recipient = sendMessageRecipient(tool);
    const body = sendMessageBody(tool);
    const outcome = sendMessageOutcome(tool.state);
    const outcomeColor = outcome === 'failed'
        ? theme.colors.warning
        : outcome === 'sent'
            ? theme.colors.success
            : theme.colors.textSecondary;

    return (
        <View style={styles.container}>
            {recipient ? (
                <View style={styles.recipient}>
                    <Ionicons name="arrow-forward-outline" size={13} color={theme.colors.textSecondary} />
                    <Text style={styles.recipientText} numberOfLines={1}>
                        {t('tools.sendMessage.to', { name: recipient })}
                    </Text>
                </View>
            ) : null}
            {body ? <MarkdownView markdown={body} /> : null}
            <View style={styles.outcome}>
                {outcome === 'sending' ? (
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                ) : (
                    <Ionicons
                        name={outcome === 'sent' ? 'checkmark-circle' : 'alert-circle'}
                        size={14}
                        color={outcomeColor}
                    />
                )}
                <Text style={[styles.outcomeText, { color: outcomeColor }]}>
                    {t(outcome === 'sent' ? 'tools.sendMessage.sent' : outcome === 'failed' ? 'tools.sendMessage.failed' : 'tools.sendMessage.sending')}
                </Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 8,
    },
    recipient: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    recipientText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    outcome: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    outcomeText: {
        fontSize: 12,
        ...Typography.default(),
    },
}));
