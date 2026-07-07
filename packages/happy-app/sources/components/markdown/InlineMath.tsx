import * as React from 'react';
import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '../StyledText';
import katex from 'katex';

/**
 * Simple HTML-to-RN-Text parser for KaTeX output.
 * KaTeX renders to <span class="katex">...<span class="mord">text</span>...<span class="msupsub">...</span></span>
 * We flatten nested spans into Text components with approximate styling.
 */
function renderKatexHtml(html: string, mathStyle: any): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    const tagRegex = /<(\/?)(\w+)[^>]*>/g;
    const entityRegex = /&([a-z]+);/g;
    let lastIndex = 0;
    let key = 0;

    const entityMap: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    };
    const numEntities: Record<string, number> = { nbsp: 160, copy: 169, reg: 174, deg: 176, pm: 177, times: 215, divide: 247 };

    const decodeEntities = (str: string) =>
        str.replace(entityRegex, (_, name: string) => entityMap[name] || String.fromCharCode(numEntities[name] || 0));

    // Collect text segments; we just extract text between tags
    // For simplicity, render as a single Text with the math style.
    // Full span-by-span rendering (with sup/sub) would be far more complex
    // and isn't needed for basic readability.
    let match: RegExpExecArray | null;
    let textContent = '';
    while ((match = tagRegex.exec(html)) !== null) {
        if (match[1] === '') {
            // Opening tag — get text before it
            const before = html.slice(lastIndex, match.index);
            textContent += decodeEntities(before);
            lastIndex = tagRegex.lastIndex;
        } else {
            // Closing tag
            const before = html.slice(lastIndex, match.index);
            textContent += decodeEntities(before);
            lastIndex = tagRegex.lastIndex;
        }
    }
    // Remaining text
    textContent += decodeEntities(html.slice(lastIndex));

    if (textContent.trim()) {
        nodes.push(<Text key={key++} style={mathStyle}>{textContent}</Text>);
    }
    return nodes;
}

export const InlineMath = React.memo((props: {
    expr: string;
}) => {
    let displayHtml: string;
    try {
        displayHtml = katex.renderToString(props.expr, {
            displayMode: false,
            throwOnError: false,
        });
    } catch {
        return <Text style={style.fallback}>${props.expr}$</Text>;
    }

    // Web platform: use dangerouslySetInnerHTML
    if (Platform.OS === 'web') {
        return (
            // @ts-ignore - Web only
            <span
                style={{ display: 'inline' }}
                dangerouslySetInnerHTML={{ __html: displayHtml }}
            />
        );
    }

    // iOS/Android: parse HTML to RN Text components
    const nodes = React.useMemo(
        () => renderKatexHtml(displayHtml, style.math),
        [displayHtml],
    );

    return <Text style={style.math}>{nodes}</Text>;
});

const style = StyleSheet.create((theme) => ({
    math: {
        fontStyle: 'italic',
        color: theme.colors.text,
    },
    fallback: {
        color: theme.colors.textSecondary,
    },
}));
