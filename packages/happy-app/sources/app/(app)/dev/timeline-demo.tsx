import * as React from 'react';
import {
    View,
    ScrollView,
    Text as RNText,
    Pressable,
} from 'react-native';
import { computeMessageClusters, ClusteredMessage, TaskClusterMessage } from '@/components/clusterTimeline';
import { TaskListView } from '@/components/TaskListView';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from '@/sync/typesMessage';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSearchParams } from 'expo-router';

// ---------------------------------------------------------------------------
// Test scenario definitions
// ---------------------------------------------------------------------------

let _id = 0;
function nid(p = 'm'): string { return `${p}-${++_id}`; }

function ut(text: string, createdAt: number): UserTextMessage {
    return { kind: 'user-text', id: nid('u'), localId: null, createdAt, text };
}
function at(text: string, createdAt: number): AgentTextMessage {
    return { kind: 'agent-text', id: nid('a'), localId: null, createdAt, text };
}
function tc(name: string, createdAt: number, input: Record<string, unknown>): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: nid('tc'),
        localId: null,
        createdAt,
        tool: { name, state: 'running', input, createdAt, startedAt: null, completedAt: null, description: null },
        children: [],
    };
}
function taskCreate(subject: string, createdAt: number, desc?: string): ToolCallMessage {
    return tc('TaskCreate', createdAt, { subject, description: desc || subject, activeForm: '' });
}
function taskUpdate(taskId: string, status: string, createdAt: number): ToolCallMessage {
    return tc('TaskUpdate', createdAt, { taskId, status });
}

interface Scenario {
    name: string;
    description: string;
    messages: Message[];
}

const SCENARIOS: Scenario[] = [
    {
        name: '单任务生命周期',
        description: 'TaskCreate → in_progress → completed，中间有 tool call 被吸收',
        messages: [
            ut('帮我修个 bug', 1000),
            taskCreate('修复登录页崩溃', 2000),
            tc('Bash', 3000, { command: 'npm test' }),
            taskUpdate('1', 'in_progress', 3500),
            tc('Read', 4000, { file: 'Login.tsx' }),
            taskUpdate('1', 'completed', 5000),
        ],
    },
    {
        name: '三个并发任务',
        description: '三个 TaskCreate 交错完成，验证各自独立状态',
        messages: [
            ut('做三个任务', 1000),
            taskCreate('任务 A：重构', 2000),
            taskCreate('任务 B：测试', 2500),
            taskCreate('任务 C：文档', 3000),
            taskUpdate('1', 'in_progress', 3200),
            taskUpdate('1', 'completed', 4000),
            taskUpdate('3', 'completed', 5000),
        ],
    },
    {
        name: 'Tool Call 吸收',
        description: 'activeCount > 0 期间的非任务 tool call 全部隐藏',
        messages: [
            taskCreate('跑构建', 1000),
            tc('Bash', 1500, { command: 'make' }),
            tc('Bash', 2000, { command: 'make test' }),
            tc('Read', 2500, { file: 'build.log' }),
            tc('Write', 3000, { file: 'result.txt', content: 'OK' }),
            taskUpdate('1', 'completed', 3500),
            tc('Bash', 4000, { command: 'echo done' }),
        ],
    },
    {
        name: '前向吸收（Backward Extension）',
        description: 'TaskCreate 之前的 tool call 被吸入 timeline',
        messages: [
            ut('看下项目', 500),
            tc('Bash', 1000, { command: 'git status' }),
            tc('Read', 1200, { file: 'README.md' }),
            taskCreate('分析项目结构', 1500),
            taskUpdate('1', 'completed', 2000),
        ],
    },
    {
        name: '无任务',
        description: '没有 TaskCreate 时，所有消息原样通过',
        messages: [
            ut('列出文件', 1000),
            tc('Bash', 2000, { command: 'ls' }),
            at('共 5 个文件', 2500),
            ut('谢谢', 3000),
        ],
    },
    {
        name: '过时 TaskUpdate',
        description: 'TaskUpdate 的 createdAt 早于第一个 TaskCreate — 被丢弃',
        messages: [
            tc('TaskUpdate', 500, { taskId: '999', status: 'completed' }),
            taskCreate('真正任务', 2000),
            taskUpdate('1', 'in_progress', 2500),
        ],
    },
    {
        name: '空输入',
        description: '0 条消息 → 空输出',
        messages: [],
    },
    {
        name: '无user-text多batch',
        description: '模拟真实session：无user-text，TaskUpdate先于TaskCreate，多轮task batch',
        messages: [
            // batch 1: pre-updates then TaskCreates
            tc('TaskUpdate', 500, { taskId: '1', status: 'completed' }),
            tc('TaskUpdate', 600, { taskId: '2', status: 'completed' }),
            tc('Bash', 700, { command: 'setup' }),
            tc('TaskUpdate', 800, { taskId: '3', status: 'in_progress' }),
            taskCreate('Batch1-A', 1000, 'Batch1-A'),
            taskCreate('Batch1-B', 1100, 'Batch1-B'),
            taskCreate('Batch1-C', 1200, 'Batch1-C'),
            tc('Bash', 1300, { command: 'build' }),
            taskUpdate('1', 'completed', 1400),
            taskUpdate('2', 'completed', 1500),
            taskUpdate('3', 'completed', 1600),
            // batch 2: all previous done (activeCount=0), new TaskCreate starts new cluster
            taskCreate('Batch2-A', 2000, 'Batch2-A'),
            taskCreate('Batch2-B', 2100, 'Batch2-B'),
            tc('Bash', 2200, { command: 'deploy' }),
            taskUpdate('4', 'in_progress', 2300),
            taskUpdate('5', 'completed', 2400),
            taskUpdate('4', 'completed', 2500),
        ],
    },
    {
        name: '多回合（BUG 复现）',
        description: '两轮对话各有独立 TaskCreate，应渲染两个 timeline card',
        messages: [
            ut('第一轮：修 bug', 1000),
            taskCreate('修复登录崩溃', 2000),
            taskUpdate('1', 'in_progress', 2500),
            tc('Bash', 3000, { command: 'git log' }),
            taskUpdate('1', 'completed', 3500),
            at('修好了', 4000),
            ut('第二轮：加功能', 5000),
            taskCreate('添加导出按钮', 6000),
            taskUpdate('2', 'in_progress', 6500),
            tc('Write', 7000, { file: 'Export.tsx', content: '...' }),
            taskUpdate('2', 'completed', 7500),
            at('加好了', 8000),
        ],
    },
];

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    chipRow: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
    },
    chip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        marginRight: 6,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    chipActive: {
        backgroundColor: '#007AFF',
        borderColor: '#007AFF',
    },
    chipText: {
        fontSize: 13,
        color: theme.colors.text,
    },
    chipTextActive: {
        color: '#FFFFFF',
    },
    descBox: {
        marginHorizontal: 12,
        marginBottom: 12,
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
    },
    descText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        lineHeight: 18,
    },
    resultSection: {
        flex: 1,
        marginHorizontal: 12,
        marginBottom: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    resultHeader: {
        flexDirection: 'row',
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        gap: 12,
    },
    resultHeaderText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    messageItem: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    messageKind: {
        fontSize: 10,
        color: '#8E8E93',
    },
    messageBody: {
        fontSize: 13,
        color: theme.colors.text,
        marginTop: 2,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 80,
    },
    emptyText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
    },
}));

// ---------------------------------------------------------------------------
// Result panel
// ---------------------------------------------------------------------------

function DebugTimeline({ result }: { result: ClusteredMessage[] }) {
    const st = styles;

    if (result.length === 0) {
        return (
            <View style={st.emptyState}>
                <RNText style={st.emptyText}>空输出</RNText>
            </View>
        );
    }

    let absorbedCount = 0;
    for (const m of result) {
        if (m.kind === 'task-cluster') {
            absorbedCount += (m as TaskClusterMessage).collapsedCount;
        }
    }

    return (
        <View style={{ flex: 1 }}>
            <View style={st.resultHeader}>
                <RNText style={st.resultHeaderText}>
                    {result.length} 条输出
                </RNText>
                {absorbedCount > 0 && (
                    <RNText style={st.resultHeaderText}>
                        {absorbedCount} tool call 被吸收
                    </RNText>
                )}
            </View>

            <ScrollView style={{ flex: 1 }}>
                {result.map((m, i) => {
                    if (m.kind === 'task-cluster') {
                        return (
                            <View key={`tc-${i}`}>
                                <TaskListView tasks={m.tasks} />
                            </View>
                        );
                    }
                    let body = '';
                    let kindLabel = m.kind;
                    if (m.kind === 'user-text') body = m.text;
                    else if (m.kind === 'agent-text') body = m.text;
                    else if (m.kind === 'tool-call') body = `${m.tool.name}: ${JSON.stringify(m.tool.input).slice(0, 60)}`;
                    else if (m.kind === 'agent-event') body = JSON.stringify(m.event);

                    return (
                        <View key={`msg-${i}`} style={st.messageItem}>
                            <RNText style={st.messageKind}>{kindLabel}</RNText>
                            <RNText style={st.messageBody} numberOfLines={3}>
                                {body}
                            </RNText>
                        </View>
                    );
                })}
            </ScrollView>
        </View>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TimelineDemoScreen() {
    const params = useLocalSearchParams<{ scenario?: string }>();
    const initialIdx = React.useMemo(() => {
        const n = parseInt(params.scenario ?? '', 10);
        return (n >= 0 && n < SCENARIOS.length) ? n : 0;
    }, [params.scenario]);
    const [scenarioIdx, setScenarioIdx] = React.useState(initialIdx);
    const scenario = SCENARIOS[scenarioIdx];
    const result = React.useMemo(
        () => computeMessageClusters(scenario.messages),
        [scenario.messages],
    );

    const st = styles;

    return (
        <View style={st.container}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={st.chipRow}
            >
                {SCENARIOS.map((s, i) => (
                    <Pressable
                        key={s.name}
                        testID={`scenario-chip-${i}`}
                        style={[st.chip, i === scenarioIdx && st.chipActive]}
                        onPress={() => setScenarioIdx(i)}
                    >
                        <RNText
                            style={[
                                st.chipText,
                                i === scenarioIdx && st.chipTextActive,
                            ]}
                        >
                            {s.name}
                        </RNText>
                    </Pressable>
                ))}
            </ScrollView>

            <View style={st.descBox}>
                <RNText style={st.descText}>{scenario.description}</RNText>
            </View>

            <View style={st.resultHeader}>
                <RNText style={st.resultHeaderText}>
                    输入: {scenario.messages.length} 条消息
                </RNText>
                <RNText style={st.resultHeaderText}>
                    TaskCreate: {scenario.messages.filter((m: any) => m.kind === 'tool-call' && m.tool?.name === 'TaskCreate').length}
                </RNText>
                <RNText style={st.resultHeaderText}>
                    TaskUpdate: {scenario.messages.filter((m: any) => m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate').length}
                </RNText>
            </View>

            <View style={st.resultSection}>
                <DebugTimeline result={result} />
            </View>
        </View>
    );
}
