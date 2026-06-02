import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet } from 'react-native-unistyles';
import { ToolViewProps } from './_all';

/**
 * Minimal card for Skill tool calls.
 * Shows the skill name and optional args; full details in the expanded view.
 */
export const SkillView = React.memo((props: ToolViewProps) => {
    const skill = (props.tool.input as any)?.skill || 'unknown';
    const args = (props.tool.input as any)?.args || '';
    const showArgs = args && typeof args === 'string' && args.trim().length > 0;

    return (
        <View style={styles.container}>
            <View style={styles.row}>
                <Text style={styles.skillText} numberOfLines={2}>{skill}</Text>
            </View>
            {showArgs ? (
                <Text style={styles.args} numberOfLines={3}>{args}</Text>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: 4,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    skillText: {
        fontSize: 12,
        color: theme.colors.text,
    },
    args: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
}));
