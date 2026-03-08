import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { ToolViewProps } from './_all';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { knownTools } from '@/components/tools/knownTools';
import { useLazyToolInput } from './useLazyToolInput';

export const WriteViewFull = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { resolvedInput, loading } = useLazyToolInput(tool, sessionId);

    let contents = '';
    const parsed = knownTools.Write.input.safeParse(resolvedInput);
    if (parsed.success && typeof parsed.data.content === 'string') {
        contents = parsed.data.content;
    }

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            {loading && (
                <ActivityIndicator size="small" style={{ marginBottom: 8 }} />
            )}
            <ToolDiffView
                oldText={''}
                newText={contents}
                style={{ width: '100%' }}
                showLineNumbers={true}
                showPlusMinusSymbols={true}
            />
        </View>
    );
});
