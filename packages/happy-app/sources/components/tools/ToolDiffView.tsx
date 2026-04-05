import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { DiffView } from '@/components/diff/DiffView';
import { DiffResult } from '@/components/diff/calculateDiff';
import { useSetting } from '@/sync/storage';

interface ToolDiffViewProps {
    oldText?: string;
    newText?: string;
    parsedDiff?: DiffResult;
    style?: any;
    showLineNumbers?: boolean;
    showPlusMinusSymbols?: boolean;
    maxLines?: number;
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({ 
    oldText = '',
    newText = '',
    parsedDiff,
    style,
    showLineNumbers = false,
    showPlusMinusSymbols = false,
    maxLines,
}) => {
    const wrapLines = useSetting('wrapLinesInDiffs');

    const diffView = (
        <DiffView
            oldText={oldText}
            newText={newText}
            parsedDiff={parsedDiff}
            wrapLines={wrapLines}
            showLineNumbers={showLineNumbers}
            showPlusMinusSymbols={showPlusMinusSymbols}
            maxLines={maxLines}
            style={wrapLines ? { flex: 1, ...style } : { minWidth: '100%' }}
        />
    );

    if (wrapLines) {
        return <View style={{ flex: 1 }}>{diffView}</View>;
    }

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={true}
        >
            {diffView}
        </ScrollView>
    );
});