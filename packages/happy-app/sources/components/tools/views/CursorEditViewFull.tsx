import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { ToolViewProps } from './_all';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';
import { useLazyToolInput } from './useLazyToolInput';

export const CursorEditViewFull = React.memo<ToolViewProps>(({ tool, sessionId, messageId }) => {
    // Fetches full args and/or full result via RPC when either tool.lazyContent or
    // result.success._lazyResult is set; resolves both in the store before re-rendering.
    const { loading } = useLazyToolInput(tool, sessionId, messageId);

    // Prefer full-file before/after from result (populated after RPC resolves the lazy result).
    // Fall back to input fields for in-progress tools or when result has no file content.
    const { input, result } = tool;
    const successResult = result?.success ?? result;
    const oldString = typeof successResult?.beforeFullFileContent === 'string'
        ? trimIdent(successResult.beforeFullFileContent)
        : trimIdent(input?.old_string || '');
    const newString = typeof successResult?.afterFullFileContent === 'string'
        ? trimIdent(successResult.afterFullFileContent)
        : trimIdent(input?.new_string || input?.streamContent || '');

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
