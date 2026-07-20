import * as React from 'react';
import { ToolViewProps } from './_all';
import { Text, View, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { knownTools } from '../../tools/knownTools';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { MarkdownView } from '@/components/markdown/MarkdownView';

interface FilteredTool {
    tool: ToolCall;
    title: string;
    state: 'running' | 'completed' | 'error';
}

function extractTaskResult(result: unknown): string | null {
    if (typeof result === 'string' && result.trim()) return result;
    if (Array.isArray(result)) {
        const text = result
            .filter((b: any) => b?.type === 'text' && typeof b?.text === 'string')
            .map((b: any) => b.text as string)
            .join('\n\n');
        return text.trim() || null;
    }
    // Handle structured task_notification/task_started results from Workflow/Agent/Monitor
    if (result && typeof result === 'object' && !Array.isArray(result)) {
        const obj = result as Record<string, unknown>;
        if (typeof obj.summary === 'string' && obj.summary.trim()) return obj.summary;
        if (typeof obj.task_notification === 'string') return `Task ${obj.task_notification}`;
        if (typeof obj.task_progress === 'string') return obj.task_progress;
        if (obj.status === 'async_launched') return 'Launched…';
    }
    return null;
}

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata, messages, compact }) => {
    const { theme } = useUnistyles();
    const filtered: FilteredTool[] = [];

    let lastAgentText: string | null = null;

    for (let m of messages) {
        if (m.kind === 'agent-text' && m.text) {
            lastAgentText = m.text;
        }
        if (m.kind === 'tool-call') {
            const knownTool = knownTools[m.tool.name as keyof typeof knownTools] as any;
            
            let title = m.tool.name;
            if (knownTool) {
                if ('extractDescription' in knownTool && typeof knownTool.extractDescription === 'function') {
                    title = knownTool.extractDescription({ tool: m.tool, metadata });
                } else if (knownTool.title) {
                    if (typeof knownTool.title === 'function') {
                        title = knownTool.title({ tool: m.tool, metadata });
                    } else {
                        title = knownTool.title;
                    }
                }
            }

            if (m.tool.state === 'running' || m.tool.state === 'completed' || m.tool.state === 'error') {
                // Prefer session-provided description (e.g. "Run `ls -la`") when title is generic "终端"
                let displayTitle = title;
                if (title === t('tools.names.terminal') && m.tool.description?.startsWith('Run `') && m.tool.description.endsWith('`')) {
                    displayTitle = m.tool.description.slice(5, -1);
                }
                filtered.push({
                    tool: m.tool,
                    title: displayTitle,
                    state: m.tool.state
                });
            }
        }
    }

    const resultSummary = !compact && tool.state === 'completed'
        ? (extractTaskResult(tool.result) ?? lastAgentText)
        : null;

    if (filtered.length === 0 && !resultSummary) {
        return null;
    }

    const styles = StyleSheet.create({
        container: {
            paddingVertical: 4,
            paddingBottom: 12
        },
        toolItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 4,
            paddingLeft: 4,
            paddingRight: 2
        },
        toolIconWrap: {
            marginRight: 8,
        },
        toolTitle: {
            fontSize: 14,
            fontWeight: '500',
            color: theme.colors.textSecondary,
            fontFamily: 'monospace',
            flex: 1,
        },
        statusContainer: {
            marginLeft: 'auto',
            paddingLeft: 8,
        },
        loadingItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 8,
            paddingHorizontal: 4,
        },
        loadingText: {
            marginLeft: 8,
            fontSize: 14,
            color: theme.colors.textSecondary,
        },
        moreToolsItem: {
            paddingVertical: 4,
            paddingHorizontal: 4,
        },
        moreToolsText: {
            fontSize: 14,
            color: theme.colors.textSecondary,
            fontStyle: 'italic',
            opacity: 0.7,
        },
        summaryContainer: {
            paddingHorizontal: 4,
            paddingTop: 8,
        },
    });

    const visibleTools = filtered.slice(filtered.length - 3);
    const remainingCount = filtered.length - 3;
    const iconSize = 16;

    return (
        <View style={styles.container}>
            {visibleTools.map((item, index) => {
                const knownTool = knownTools[item.tool.name as keyof typeof knownTools] as any;
                const icon = knownTool?.icon ? knownTool.icon(iconSize, theme.colors.textSecondary) : null;
                return (
                <View key={`${item.tool.name}-${index}`} style={styles.toolItem}>
                    {icon != null && <View style={styles.toolIconWrap}>{icon}</View>}
                    <Text style={styles.toolTitle} numberOfLines={1}>{item.title}</Text>
                    <View style={styles.statusContainer}>
                        {item.state === 'running' && (
                            <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={theme.colors.warning} />
                        )}
                        {item.state === 'completed' && (
                            <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
                        )}
                        {item.state === 'error' && (
                            <Ionicons name="close-circle" size={16} color={theme.colors.textDestructive} />
                        )}
                    </View>
                </View>
                );
            })}
            {remainingCount > 0 && (
                <View style={styles.moreToolsItem}>
                    <Text style={styles.moreToolsText}>
                        {t('tools.taskView.moreTools', { count: remainingCount })}
                    </Text>
                </View>
            )}
            {resultSummary != null && (
                <View style={styles.summaryContainer}>
                    <MarkdownView markdown={resultSummary} />
                </View>
            )}
        </View>
    );
});
