import * as React from 'react';
import { useMemo } from 'react';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';
import { parseUnifiedDiff } from '@/components/diff/calculateDiff';
import { unwrapToolResult } from './toolResult';

const LIST_DIFF_MAX_LINES = 4;

export const CursorEditView = React.memo<ToolViewProps>(({ tool, compact }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const { input, result } = tool;

    // Prefer Cursor's pre-computed diffString from result — small wire payload, correct line numbers.
    const successResult = unwrapToolResult(result);
    const diffString: string | undefined = typeof successResult?.diffString === 'string'
        ? successResult.diffString
        : typeof result?.diffString === 'string' ? result.diffString : undefined;

    const parsedDiff = useMemo(
        () => diffString ? parseUnifiedDiff(diffString) : undefined,
        [diffString],
    );
    const hasParsedDiff = !!parsedDiff && parsedDiff.hunks.length > 0;

    // Fallback: reconstruct from truncated before/after or input fields (pre-completion / no diffString).
    const oldString = hasParsedDiff ? '' : trimIdent(
        typeof successResult?.beforeFullFileContent === 'string'
            ? successResult.beforeFullFileContent
            : (input?.old_string || ''),
    );
    const newString = hasParsedDiff ? '' : trimIdent(
        typeof successResult?.afterFullFileContent === 'string'
            ? successResult.afterFullFileContent
            : (input?.new_string || input?.streamContent || ''),
    );

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView
                    parsedDiff={hasParsedDiff ? parsedDiff : undefined}
                    oldText={oldString}
                    newText={newString}
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                    maxLines={compact ? LIST_DIFF_MAX_LINES : undefined}
                />
            </ToolSectionView>
        </>
    );
});
