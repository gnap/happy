import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { ToolViewProps } from './_all';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useLazyToolInput } from './useLazyToolInput';

export const CursorWriteViewFull = React.memo<ToolViewProps>(({ tool, sessionId, messageId }) => {
    // Fetches full args and/or full result via RPC when either tool.lazyContent or
    // result.success._lazyResult is set; resolves both in the store before re-rendering.
    const { loading } = useLazyToolInput(tool, sessionId, messageId);

    // Prefer afterFullFileContent from result (populated after RPC resolves the lazy result).
    // Fall back to input fields for in-progress tools.
    const { input, result } = tool;
    const successResult = result?.success ?? result;
    const contents = typeof successResult?.afterFullFileContent === 'string'
        ? successResult.afterFullFileContent
        : typeof input?.content === 'string' ? input.content
        : typeof input?.streamContent === 'string' ? input.streamContent
        : '';

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
