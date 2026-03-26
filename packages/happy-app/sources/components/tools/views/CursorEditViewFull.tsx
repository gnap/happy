import * as React from 'react';
import { useMemo } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { ToolViewProps } from './_all';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';
import { useLazyToolInput } from './useLazyToolInput';
import { parseUnifiedDiff } from '@/components/diff/calculateDiff';
import { unwrapToolResult } from './toolResult';

export const CursorEditViewFull = React.memo<ToolViewProps>(({ tool, sessionId, messageId }) => {
    // Fetches full args and/or full result via RPC when either tool.lazyContent or
    // result.success._lazyResult is set; resolves both in the store before re-rendering.
    const { loading } = useLazyToolInput(tool, sessionId, messageId);

    const { input, result } = tool;
    const successResult = unwrapToolResult(result);

    // Prefer Cursor's pre-computed diffString — small payload, always present before RPC resolves,
    // contains correct line numbers. Fall back to full-file before/after once RPC resolves.
    const diffString: string | undefined = typeof successResult?.diffString === 'string'
        ? successResult.diffString
        : typeof result?.diffString === 'string' ? result.diffString : undefined;

    const parsedDiff = useMemo(
        () => diffString ? parseUnifiedDiff(diffString) : undefined,
        [diffString],
    );
    const hasParsedDiff = !!parsedDiff && parsedDiff.hunks.length > 0;

    // Only fall back to reconstructed before/after when no parsedDiff is available
    // (in-progress streaming, or after RPC resolves full file content).
    const oldString = hasParsedDiff ? '' : typeof successResult?.beforeFullFileContent === 'string'
        ? trimIdent(successResult.beforeFullFileContent)
        : trimIdent(input?.old_string || '');
    const newString = hasParsedDiff ? '' : typeof successResult?.afterFullFileContent === 'string'
        ? trimIdent(successResult.afterFullFileContent)
        : trimIdent(input?.new_string || input?.streamContent || '');

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            {loading && (
                <ActivityIndicator size="small" style={{ marginBottom: 8 }} />
            )}
            <ToolDiffView
                parsedDiff={hasParsedDiff ? parsedDiff : undefined}
                oldText={oldString}
                newText={newString}
                style={{ width: '100%' }}
                showLineNumbers={true}
                showPlusMinusSymbols={true}
            />
        </View>
    );
});
