import React, { useRef, useEffect } from 'react';
import { View, Animated } from 'react-native';
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

const LINE_COLOR = '#e0e0e0';

const DOT_COLORS: Record<TaskStatus, string> = {
    completed: '#34C759',
    in_progress: '#FFCC00',
    pending: '#999',
};

function childLabel(task: TaskItem): string {
    const count = task.collapsedCount ?? 0;
    const calls = count > 0 ? ` (${count} tool ${count === 1 ? 'call' : 'calls'})` : '';
    switch (task.status) {
        case 'completed':
            return `completed${calls}`;
        case 'in_progress':
            return count > 0 ? `running${calls}...` : 'running...';
        default:
            return 'waiting...';
    }
}

function TaskDot({ status }: { status: TaskStatus }) {
    const anim = useRef(new Animated.Value(status === 'in_progress' ? 1 : 1)).current;

    useEffect(() => {
        if (status === 'in_progress') {
            const pulse = Animated.loop(
                Animated.sequence([
                    Animated.timing(anim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
                    Animated.timing(anim, { toValue: 1, duration: 800, useNativeDriver: true }),
                ])
            );
            pulse.start();
            return () => pulse.stop();
        } else {
            anim.setValue(1);
        }
    }, [status, anim]);

    return (
        <View style={twodot.wrap}>
            <Animated.View
                style={[
                    twodot.dot,
                    { backgroundColor: DOT_COLORS[status], opacity: anim },
                ]}
            />
        </View>
    );
}

const twodot = StyleSheet.create({
    wrap: {
        width: 20,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 4,
    },
    dot: {
        width: 10,
        height: 10,
        borderRadius: 5,
    },
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    taskRow: {
        flexDirection: 'row',
        minHeight: 28,
    },
    childRow: {
        flexDirection: 'row',
        minHeight: 22,
    },
    timelineCol: {
        width: 20,
        alignItems: 'center',
    },
    lineBox: {
        flex: 1,
        width: 2,
        backgroundColor: LINE_COLOR,
    },
    contentCol: {
        flex: 1,
        paddingLeft: 6,
        paddingTop: 3,
    },
    taskText: {
        fontSize: 13,
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
                const dotColor = DOT_COLORS[task.status] ?? DOT_COLORS.pending;

                return (
                    <React.Fragment key={task.id}>
                        {/* Top-level: task title */}
                        <View style={styles.taskRow}>
                            <View style={styles.timelineCol}>
                                <TaskDot status={task.status} />
                                <View style={styles.lineBox} />
                            </View>
                            <View style={styles.contentCol}>
                                <Text
                                    style={[
                                        styles.taskText,
                                        { color: dotColor },
                                        ...(task.status === 'completed'
                                            ? [{ textDecorationLine: 'line-through' as const }]
                                            : []),
                                    ]}
                                    numberOfLines={2}
                                >
                                    {task.content}
                                </Text>
                            </View>
                        </View>
                        {/* Child: execution status */}
                        <View style={styles.childRow}>
                            <View style={styles.timelineCol}>
                                {!isLast && <View style={styles.lineBox} />}
                            </View>
                            <View style={styles.contentCol}>
                                <Text style={styles.childText} numberOfLines={1}>
                                    {childLabel(task)}
                                </Text>
                            </View>
                        </View>
                    </React.Fragment>
                );
            })}
        </View>
    );
});
