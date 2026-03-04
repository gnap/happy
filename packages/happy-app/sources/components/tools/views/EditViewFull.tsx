import * as React from 'react';
import { View } from 'react-native';
import { ToolViewProps } from './_all';
import { knownTools } from '@/components/tools/knownTools';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { trimIdent } from '@/utils/trimIdent';

export const EditViewFull = React.memo<ToolViewProps>(({ tool, metadata }) => {
    const { input } = tool;

    // Parse the input
    let oldString = '';
    let newString = '';
    const parsed = knownTools.Edit.input.safeParse(input);
    if (parsed.success) {
        oldString = trimIdent(parsed.data.old_string || '');
        newString = trimIdent(parsed.data.new_string || '');
    }

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