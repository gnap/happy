import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { ToolViewProps } from './_all';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';
import { useLazyToolInput } from './useLazyToolInput';

export const CursorEditViewFull = React.memo<ToolViewProps>(({ tool, sessionId, messageId }) => {
    const { result } = tool;
    const successResult = result?.success ?? result;

    // When the tool is completed, the result carries full file content — no RPC needed.
    // Only fetch lazily while the tool is still running (result not yet available).
    const hasResultContent = typeof successResult?.beforeFullFileContent === 'string';
    const { loading } = useLazyToolInput(
        tool,
        hasResultContent ? undefined : sessionId,
        messageId,
    );

    // After a successful fetch, resolveToolCallLazyContent updates tool.input in the store
    // so the parent re-renders with full content — read directly from tool.input here.
    const oldString = hasResultContent
        ? successResult.beforeFullFileContent
        : trimIdent(typeof tool.input?.old_string === 'string' ? tool.input.old_string : '');
    const newString = hasResultContent
        ? successResult.afterFullFileContent
        : trimIdent(typeof tool.input?.new_string === 'string' ? tool.input.new_string
            : typeof tool.input?.streamContent === 'string' ? tool.input.streamContent : '');

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
