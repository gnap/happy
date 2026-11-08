import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ToolViewProps } from './_all';

/**
 * The other sessions reachable from this one.
 *
 * The tool answers in prose — which sessions can be written to, and what it means when none can —
 * so it is shown as it was written rather than parsed into rows that would lose the explanation.
 * A list that is empty is still worth reading: it says why.
 */
export const ListAgentsView = React.memo<ToolViewProps>(({ tool }) => {
    const { theme } = useUnistyles();
    const text = resultText(tool.result);

    if (!text && tool.state === 'running') {
        return (
            <View style={styles.container}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    if (!text) {
        return null;
    }
    return (
        <View style={styles.container}>
            <Text style={styles.text}>{text}</Text>
        </View>
    );
});

/** A tool result arrives as text, as text blocks, or as something with a `content` list inside. */
function resultText(result: unknown): string | null {
    if (typeof result === 'string') {
        return result.trim() || null;
    }
    const blocks: unknown[] = Array.isArray(result)
        ? result
        : Array.isArray((result as { content?: unknown[] } | null)?.content)
            ? (result as { content: unknown[] }).content
            : [];
    const text = blocks
        .filter((block): block is { type: string; text: string } =>
            typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
            && typeof (block as { text?: unknown }).text === 'string')
        .map((block) => block.text)
        .join('\n\n')
        .trim();
    return text.length > 0 ? text : null;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: 2,
    },
    text: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
}));
