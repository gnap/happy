import * as React from 'react';
import { View } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { toolFullViewStyles } from '../ToolFullView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';

interface CursorWriteViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const CursorWriteViewFull = React.memo<CursorWriteViewFullProps>(({ tool }) => {
    const { input, result } = tool;

    // Prefer afterFullFileContent from result (Cursor agent provides full file content).
    // Fall back to input.content or input.streamContent.
    const successResult = result?.success ?? result;
    const contents = typeof successResult?.afterFullFileContent === 'string'
        ? successResult.afterFullFileContent
        : typeof input?.content === 'string' ? input.content
        : typeof input?.streamContent === 'string' ? input.streamContent
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
