import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskItem {
    id: string;
    content: string;
    status: TaskStatus;
    collapsedCount?: number;
}

const STATUS_CONFIG: Record<TaskStatus, { icon: string; color: string; textDecoration?: 'line-through' }> = {
    completed: { icon: '☑', color: '#34C759', textDecoration: 'line-through' },
    in_progress: { icon: '○', color: '#007AFF' },
    pending: { icon: '○', color: '#666' },
};

const STATUS_LABEL: Record<TaskStatus, string> = {
    completed: 'completed',
    in_progress: 'in progress',
    pending: 'pending',
};

const LINE_COLOR = '#e0e0e0';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    // Top-level task node
    taskRow: {
        flexDirection: 'row',
        minHeight: 28,
    },
    // Child status node (below each task)
    childRow: {
        flexDirection: 'row',
        minHeight: 22,
    },
    timelineCol: {
        width: 20,
        alignItems: 'center',
    },
    lineContainer: {
        flex: 1,
        width: 2,
        backgroundColor: LINE_COLOR,
    },
    dot: {
        width: 20,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 2,
    },
    dotText: {
        fontSize: 12,
        lineHeight: 16,
    },
    contentCol: {
        flex: 1,
        paddingLeft: 6,
        paddingTop: 3,
    },
    contentText: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    childText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export const TaskListView = React.memo(({ tasks }: { tasks?: TaskItem[] }) => {
    const styles = stylesheet;

    if (!tasks || tasks.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
            {tasks.map((task, index) => {
                const isLast = index === tasks.length - 1;
                const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending;
                const statusLabel = STATUS_LABEL[task.status] ?? 'pending';
                const hasChild = task.collapsedCount !== undefined && task.collapsedCount > 0;

                // Child node text mimics TUI: "completed (N tool calls)" or just "completed"
                const childText = hasChild
                    ? `${statusLabel} (${task.collapsedCount} tool ${task.collapsedCount === 1 ? 'call' : 'calls'})`
                    : statusLabel;

                return (
                    <React.Fragment key={task.id}>
                        {/* Top-level: task title with colored status */}
                        <View style={styles.taskRow}>
                            <View style={styles.timelineCol}>
                                <View style={styles.dot}>
                                    <Text style={[styles.dotText, { color: cfg.color }]}>
                                        {cfg.icon}
                                    </Text>
                                </View>
                                <View style={styles.lineContainer} />
                            </View>
                            <View style={styles.contentCol}>
                                <Text
                                    style={[
                                        styles.contentText,
                                        { color: cfg.color },
                                        ...(cfg.textDecoration ? [{ textDecorationLine: cfg.textDecoration as 'line-through' }] : []),
                                    ]}
                                    numberOfLines={2}
                                >
                                    {task.content}
                                </Text>
                            </View>
                        </View>
                        {/* Child: execution status + collapsed tool info */}
                        <View style={styles.childRow}>
                            <View style={styles.timelineCol}>
                                {!isLast && <View style={styles.lineContainer} />}
                            </View>
                            <View style={styles.contentCol}>
                                <Text style={styles.childText} numberOfLines={1}>
                                    {childText}
                                </Text>
                            </View>
                        </View>
                    </React.Fragment>
                );
            })}
        </View>
    );
});
