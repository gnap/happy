import * as React from 'react';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';

const LIST_DIFF_MAX_LINES = 4;

export const CursorEditView = React.memo<ToolViewProps>(({ tool, compact }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const { input, result } = tool;

    // Prefer full-file before/after from result (Cursor agent provides these on completion).
    // Fall back to streamContent-based diff or input old/new strings.
    const successResult = result?.success ?? result;
    const oldString = typeof successResult?.beforeFullFileContent === 'string'
        ? successResult.beforeFullFileContent
        : trimIdent(typeof input?.old_string === 'string' ? input.old_string : '');
    const newString = typeof successResult?.afterFullFileContent === 'string'
        ? successResult.afterFullFileContent
        : trimIdent(typeof input?.new_string === 'string' ? input.new_string
            : typeof input?.streamContent === 'string' ? input.streamContent : '');

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView
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
