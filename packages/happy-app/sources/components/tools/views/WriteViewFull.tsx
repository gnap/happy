import * as React from 'react';
import { View } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';

interface WriteViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const WriteViewFull = React.memo<WriteViewFullProps>(({ tool }) => {
    const { input, result } = tool;

    // Prefer the completed file content when available.
    // Fall back to the input content for tools that only provide the write payload.
    const successResult = result?.success ?? result;
    const contents = typeof successResult?.afterFullFileContent === 'string'
        ? successResult.afterFullFileContent
        : typeof input?.content === 'string'
        ? input.content
        : typeof input?.streamContent === 'string'
        ? input.streamContent
        : '';

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
