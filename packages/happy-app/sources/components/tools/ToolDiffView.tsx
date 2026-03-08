import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { DiffView } from '@/components/diff/DiffView';
import { DiffResult } from '@/components/diff/calculateDiff';
import { useSetting } from '@/sync/storage';

interface ToolDiffViewProps {
    oldText?: string;
    newText?: string;
    /** Pre-parsed diff (e.g. from Cursor's diffString). When set, oldText/newText are ignored. */
    parsedDiff?: DiffResult;
    style?: any;
    showLineNumbers?: boolean;
    showPlusMinusSymbols?: boolean;
    /** When set (e.g. list view compact), only show this many diff lines; detail view omits for full. */
    maxLines?: number;
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({
    oldText,
    newText,
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
        return (
            <View style={{ flex: 1 }}>
                {diffView}
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
            {diffView}
        </ScrollView>
    );
});