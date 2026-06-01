import * as React from 'react';
import { ToolViewProps } from './_all';
import { Text, View, ActivityIndicator, Platform } from 'react-native';
import { knownTools } from '../../tools/knownTools';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ToolSectionView } from '../ToolSectionView';

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
    return null;
}

export const AgentViewFull = React.memo<ToolViewProps>(({ tool, metadata, messages }) => {
    const { theme } = useUnistyles();
    const iconSize = 16;

    // Collect child tools
    const childTools: FilteredTool[] = [];
    for (let m of messages) {
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
                let displayTitle = title;
                if (title === t('tools.names.terminal') && m.tool.description?.startsWith('Run ') && m.tool.description.endsWith('`')) {
                    displayTitle = m.tool.description.slice(5, -1);
                }
                childTools.push({
                    tool: m.tool,
                    title: displayTitle,
                    state: m.tool.state,
                });
            }
        }
    }

    // Collect all agent-text messages
    const agentTexts: string[] = [];
    for (let m of messages) {
        if (m.kind === 'agent-text' && m.text) {
            agentTexts.push(m.text);
        }
    }

    const resultSummary = extractTaskResult(tool.result) ?? (agentTexts.length > 0 ? agentTexts[agentTexts.length - 1] : null);
    const prompt = tool.input?.prompt && typeof tool.input.prompt === 'string' ? tool.input.prompt : null;

    return (
        <View style={{ paddingVertical: 8 }}>
            {/* Prompt section */}
            {prompt !== null && (
                <ToolSectionView title={t('tools.agentView.prompt')}>
                    <MarkdownView markdown={prompt} />
                </ToolSectionView>
            )}

            {/* Tools Used section */}
            {childTools.length > 0 && (
                <ToolSectionView title={t('tools.agentView.agentTools')}>
                    {childTools.map((item, index) => {
                        const knownTool = knownTools[item.tool.name as keyof typeof knownTools] as any;
                        const icon = knownTool?.icon ? knownTool.icon(iconSize, theme.colors.textSecondary) : null;
                        return (
                            <View
                                key={`${item.tool.name}-${index}`}
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    paddingVertical: 4,
                                    paddingHorizontal: 4,
                                    gap: 8,
                                }}
                            >
                                {icon != null && <View>{icon}</View>}
                                <Text
                                    style={{
                                        fontSize: 14,
                                        fontWeight: '500',
                                        color: theme.colors.textSecondary,
                                        fontFamily: 'monospace',
                                        flex: 1,
                                    }}
                                    numberOfLines={1}
                                >
                                    {item.title}
                                </Text>
                                <View>
                                    {item.state === 'running' && (
                                        <ActivityIndicator size={Platform.OS === 'ios' ? 'small' : (14 as any)} color={theme.colors.warning} />
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
                </ToolSectionView>
            )}

            {/* Agent Output section */}
            {agentTexts.length > 0 && (
                <ToolSectionView title={t('tools.agentView.output')}>
                    {agentTexts.map((text, index) => (
                        <View key={index} style={{ marginBottom: index < agentTexts.length - 1 ? 8 : 0 }}>
                            <MarkdownView markdown={text} />
                        </View>
                    ))}
                </ToolSectionView>
            )}

            {/* Result section */}
            {resultSummary !== null && (
                <ToolSectionView title={t('tools.agentView.result')}>
                    <MarkdownView markdown={resultSummary} />
                </ToolSectionView>
            )}

            {/* Empty state */}
            {!prompt && childTools.length === 0 && agentTexts.length === 0 && tool.state === 'running' && (
                <View style={{ paddingVertical: 12, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            )}
        </View>
    );
});
