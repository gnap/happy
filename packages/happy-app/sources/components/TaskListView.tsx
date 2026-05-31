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
}

const STATUS_CONFIG: Record<TaskStatus, { icon: string; color: string; textDecoration?: 'line-through' }> = {
    completed: { icon: '☑', color: '#34C759', textDecoration: 'line-through' },
    in_progress: { icon: '○', color: '#007AFF' },
    pending: { icon: '○', color: '#666' },
};

const LINE_COLOR = '#e0e0e0';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    itemRow: {
        flexDirection: 'row',
        minHeight: 28,
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
    collapsedRow: {
        flexDirection: 'row',
        minHeight: 20,
    },
    emptyText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        fontStyle: 'italic',
    },
}));

export const TaskListView = React.memo(({ tasks, collapsedCount }: { tasks?: TaskItem[]; collapsedCount?: number }) => {
    const styles = stylesheet;

    if ((!tasks || tasks.length === 0) && !collapsedCount) {
        return null;
    }

    return (
        <View style={styles.container}>
            {(tasks ?? []).map((task, index) => {
                const isLast = index === (tasks ?? []).length - 1;
                const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending;

                return (
                    <View key={task.id} style={styles.itemRow}>
                        <View style={styles.timelineCol}>
                            <View style={styles.dot}>
                                <Text style={[styles.dotText, { color: cfg.color }]}>
                                    {cfg.icon}
                                </Text>
                            </View>
                            {!isLast && <View style={styles.lineContainer} />}
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
                );
            })}
            {collapsedCount ? (
                <View style={styles.collapsedRow}>
                    {tasks && tasks.length > 0 ? (
                        <View style={styles.timelineCol}>
                            <View style={{ flex: 1, width: 2, backgroundColor: LINE_COLOR }} />
                        </View>
                    ) : null}
                    <View style={styles.contentCol}>
                        <Text style={styles.emptyText}>
                            {collapsedCount} tool {collapsedCount === 1 ? 'call' : 'calls'} collapsed
                        </Text>
                    </View>
                </View>
            ) : null}
        </View>
    );
});
