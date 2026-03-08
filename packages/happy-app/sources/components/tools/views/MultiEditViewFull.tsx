import * as React from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { ToolViewProps } from './_all';
import { knownTools } from '@/components/tools/knownTools';
import { toolFullViewStyles } from '../ToolFullView';
import { DiffView } from '@/components/diff/DiffView';
import { trimIdent } from '@/utils/trimIdent';
import { t } from '@/text';
import { useSetting } from '@/sync/storage';
import { useLazyToolInput } from './useLazyToolInput';

export const MultiEditViewFull = React.memo<ToolViewProps>(({ tool, metadata, sessionId }) => {
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    const { resolvedInput, loading } = useLazyToolInput(tool, sessionId);

    // Parse the input
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
    
    const parsed = knownTools.MultiEdit.input.safeParse(resolvedInput);
    if (parsed.success && parsed.data.edits) {
        edits = parsed.data.edits;
    }

    if (edits.length === 0 && !loading) {
        return null;
    }

    const content = (
        <View style={{ flex: 1 }}>
            {edits.map((edit, index) => {
                const oldString = trimIdent(edit.old_string || '');
                const newString = trimIdent(edit.new_string || '');
                
                return (
                    <View key={index}>
                        <View style={styles.editHeader}>
                            <Text style={styles.editNumber}>
                                {t('tools.multiEdit.editNumber', { index: index + 1, total: edits.length })}
                            </Text>
                            {edit.replace_all && (
                                <View style={styles.replaceAllBadge}>
                                    <Text style={styles.replaceAllText}>{t('tools.multiEdit.replaceAll')}</Text>
                                </View>
                            )}
                        </View>
                        <DiffView 
                            oldText={oldString} 
                            newText={newString} 
                            wrapLines={wrapLinesInDiffs}
                            showLineNumbers={true}
                            showPlusMinusSymbols={true}
                        />
                        {index < edits.length - 1 && <View style={styles.separator} />}
                    </View>
                );
            })}
        </View>
    );

    if (wrapLinesInDiffs) {
        return (
            <View style={toolFullViewStyles.sectionFullWidth}>
                {loading && <ActivityIndicator size="small" style={{ marginBottom: 8 }} />}
                {content}
            </View>
        );
    }

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            {loading && <ActivityIndicator size="small" style={{ marginBottom: 8 }} />}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={true}
                showsVerticalScrollIndicator={true}
                nestedScrollEnabled={true}
                contentContainerStyle={{ flexGrow: 1 }}
            >
                {content}
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create({
    editHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    editNumber: {
        fontSize: 14,
        fontWeight: '600',
        color: '#5856D6',
    },
    replaceAllBadge: {
        backgroundColor: '#5856D6',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        marginLeft: 8,
    },
    replaceAllText: {
        fontSize: 12,
        color: '#fff',
        fontWeight: '600',
    },
    separator: {
        height: 1,
        backgroundColor: '#E5E5EA',
        marginVertical: 16,
    },
});
