import * as React from 'react';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { knownTools } from '../../tools/knownTools';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';


const LIST_DIFF_MAX_LINES = 4;

export const EditView = React.memo<ToolViewProps>(({ tool, compact }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    
    let oldString = '';
    let newString = '';
    const parsed = knownTools.Edit.input.safeParse(tool.input);
    if (parsed.success) {
        oldString = trimIdent(parsed.data.old_string || '');
        newString = trimIdent(parsed.data.new_string || '');
    }

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