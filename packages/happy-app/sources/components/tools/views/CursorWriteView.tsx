import * as React from 'react';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';

const LIST_DIFF_MAX_LINES = 4;

export const CursorWriteView = React.memo<ToolViewProps>(({ tool, compact }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const { input, result } = tool;

    // Prefer afterFullFileContent from result (Cursor agent provides full file content on completion).
    // Fall back to input.content or input.streamContent (streaming partial content).
    const successResult = result?.success ?? result;
    const contents = typeof successResult?.afterFullFileContent === 'string'
        ? successResult.afterFullFileContent
        : typeof input?.content === 'string' ? input.content
        : typeof input?.streamContent === 'string' ? input.streamContent
        : '';

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView
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
