import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { ToolViewProps } from './_all';
import { knownTools } from '@/components/tools/knownTools';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';
import { useLazyToolInput } from './useLazyToolInput';

export const EditViewFull = React.memo<ToolViewProps>(({ tool, metadata, sessionId }) => {
    const { resolvedInput, loading } = useLazyToolInput(tool, sessionId);

    let oldString = '';
    let newString = '';
    const parsed = knownTools.Edit.input.safeParse(resolvedInput);
    if (parsed.success) {
        oldString = trimIdent(parsed.data.old_string || '');
        newString = trimIdent(parsed.data.new_string || '');
    }

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            {loading && (
                <ActivityIndicator size="small" style={{ marginBottom: 8 }} />
            )}
            <ToolDiffView
                oldText={oldString}
                newText={newString}
                style={{ width: '100%' }}
                showLineNumbers={true}
                showPlusMinusSymbols={true}
            />
        </View>
    );
});
