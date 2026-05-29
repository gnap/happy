import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';

export const TaskTrackerView = React.memo<ToolViewProps>(({ tool }) => {
    const input = (tool.input || {}) as Record<string, unknown>;
    const subject = typeof input.subject === 'string' ? input.subject : '';
    const description = typeof input.description === 'string' ? input.description : '';
    const activeForm = typeof input.activeForm === 'string' ? input.activeForm : '';
    const taskId = typeof input.taskId === 'string' ? input.taskId : '';

    const status = typeof input.status === 'string'
        && ['pending', 'in_progress', 'completed'].includes(input.status as string)
        ? input.status as 'pending' | 'in_progress' | 'completed'
        : 'in_progress';

    const title = subject || activeForm || description || taskId;
    if (!title && !taskId) return null;

    const isCompleted = status === 'completed';
    const isInProgress = status === 'in_progress';

    let textStyle: any = styles.taskText;
    let icon = '☐';

    if (isCompleted) {
        textStyle = [styles.taskText, styles.completedText];
        icon = '☑';
    } else if (isInProgress) {
        textStyle = [styles.taskText, styles.inProgressText];
    } else {
        textStyle = [styles.taskText, styles.pendingText];
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <View style={styles.taskItem}>
                    <Text style={textStyle}>
                        {icon} {taskId ? `#${taskId} ` : ''}{title}
                    </Text>
                </View>
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create({
    container: {
        gap: 4,
    },
    taskItem: {
        paddingVertical: 2,
    },
    taskText: {
        fontSize: 14,
        color: '#000',
        flex: 1,
    },
    completedText: {
        color: '#34C759',
        textDecorationLine: 'line-through',
    },
    inProgressText: {
        color: '#007AFF',
    },
    pendingText: {
        color: '#666',
    },
});
