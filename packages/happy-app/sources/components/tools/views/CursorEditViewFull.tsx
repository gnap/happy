import * as React from 'react';
import { View } from 'react-native';
import { ToolViewProps } from './_all';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';

export const CursorEditViewFull = React.memo<ToolViewProps>(({ tool }) => {
    const { input, result } = tool;

    // Prefer full-file before/after from result (Cursor agent provides these).
    // Fall back to input old_string/new_string for any legacy format.
    const successResult = result?.success ?? result;
    const oldString = typeof successResult?.beforeFullFileContent === 'string'
        ? successResult.beforeFullFileContent
        : trimIdent(typeof input?.old_string === 'string' ? input.old_string : '');
    const newString = typeof successResult?.afterFullFileContent === 'string'
        ? successResult.afterFullFileContent
        : trimIdent(typeof input?.new_string === 'string' ? input.new_string : '');

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
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
