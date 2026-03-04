import * as React from 'react';
import { View } from 'react-native';
import { ToolViewProps } from './_all';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { knownTools } from '@/components/tools/knownTools';

export const WriteViewFull = React.memo<ToolViewProps>(({ tool }) => {
    let contents = '';
    const parsed = knownTools.Write.input.safeParse(tool.input);
    if (parsed.success && typeof parsed.data.content === 'string') {
        contents = parsed.data.content;
    }

    return (
        <View style={toolFullViewStyles.sectionFullWidth}>
            <ToolDiffView
                oldText={''}
                newText={contents}
                style={{ width: '100%' }}
                showLineNumbers={true}
                showPlusMinusSymbols={true}
            />
        </View>
    );
});
