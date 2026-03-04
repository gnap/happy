import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { CommandView } from '@/components/CommandView';

interface CursorBashViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const CursorBashViewFull = React.memo<CursorBashViewFullProps>(({ tool }) => {
    const { input, result, state } = tool;

    const command = typeof input?.command === 'string' ? input.command : '';

    let stdout: string | null = null;
    let stderr: string | null = null;
    let exitCode: number | null = null;
    let error: string | null = null;

    if (state === 'completed' && result) {
        if (typeof result === 'string') {
            stdout = result;
        } else if (result && typeof result === 'object') {
            const r = result as Record<string, unknown>;
            stdout = typeof r.stdout === 'string' ? r.stdout : null;
            stderr = typeof r.stderr === 'string' ? r.stderr : null;
            exitCode = typeof r.exitCode === 'number' ? r.exitCode : null;
        }
    } else if (state === 'error') {
        if (typeof result === 'string') {
            error = result;
        } else if (result && typeof result === 'object') {
            const r = result as Record<string, unknown>;
            stderr = typeof r.stderr === 'string' ? r.stderr : null;
            stdout = typeof r.stdout === 'string' ? r.stdout : null;
            exitCode = typeof r.exitCode === 'number' ? r.exitCode : null;
            error = stderr || stdout;
        }
    }

    return (
        <View style={styles.container}>
            <CommandView
                command={command}
                stdout={stdout}
                stderr={stderr}
                error={error}
                fullWidth
            />
            {exitCode !== null && exitCode !== 0 && (
                <Text style={styles.exitCode}>exit {exitCode}</Text>
            )}
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: 0,
        paddingTop: 32,
        paddingBottom: 64,
        flex: 1,
    },
    exitCode: {
        fontFamily: 'monospace',
        fontSize: 12,
        color: '#FF3B30',
        marginTop: 8,
        paddingHorizontal: 4,
    },
});
