import * as React from 'react';
import { useMemo } from 'react';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';
import { parseUnifiedDiff } from '@/components/diff/calculateDiff';

const LIST_DIFF_MAX_LINES = 4;

export const CursorWriteView = React.memo<ToolViewProps>(({ tool, compact }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const { input, result } = tool;

    // Prefer Cursor's pre-computed diffString from result.
    const successResult = result?.success ?? result;
    const diffString: string | undefined = typeof successResult?.diffString === 'string'
        ? successResult.diffString
        : typeof result?.diffString === 'string' ? result.diffString : undefined;

    const parsedDiff = useMemo(
        () => diffString ? parseUnifiedDiff(diffString) : undefined,
        [diffString],
    );
    const hasParsedDiff = !!parsedDiff && parsedDiff.hunks.length > 0;

    // Fallback: use afterFullFileContent or input content when no diffString available.
    const contents = hasParsedDiff ? '' : (
        typeof successResult?.afterFullFileContent === 'string' ? successResult.afterFullFileContent
        : typeof input?.content === 'string' ? input.content
        : typeof input?.streamContent === 'string' ? input.streamContent
        : ''
    );

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView
                    parsedDiff={hasParsedDiff ? parsedDiff : undefined}
                    oldText={''}
                    newText={contents}
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                    maxLines={compact ? LIST_DIFF_MAX_LINES : undefined}
                />
            </ToolSectionView>
        </>
    );
});
