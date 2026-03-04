import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { DiffView } from '@/components/diff/DiffView';
import { useSetting } from '@/sync/storage';

interface ToolDiffViewProps {
    oldText: string;
    newText: string;
    style?: any;
    showLineNumbers?: boolean;
    showPlusMinusSymbols?: boolean;
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({ 
    oldText, 
    newText, 
    style, 
    showLineNumbers = false,
    showPlusMinusSymbols = false 
}) => {
    const wrapLines = useSetting('wrapLinesInDiffs');

    if (wrapLines) {
        return (
            <View style={{ flex: 1 }}>
                <DiffView
                    oldText={oldText}
                    newText={newText}
                    wrapLines={wrapLines}
                    showLineNumbers={showLineNumbers}
                    showPlusMinusSymbols={showPlusMinusSymbols}
                    style={{ flex: 1, ...style }}
                />
            </View>
        );
    }

    // Non-wrapping: use horizontal scroll. DiffView gets only minWidth:'100%' so it
    // can grow wider than the viewport for long lines (enabling true horizontal scroll).
    // Callers must NOT pass width:'100%' via style — that would re-constrain the view
    // to the viewport and cause line truncation.
    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={true}
        >
            <DiffView
                oldText={oldText}
                newText={newText}
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPlusMinusSymbols={showPlusMinusSymbols}
                style={{ minWidth: '100%' }}
            />
        </ScrollView>
    );
});