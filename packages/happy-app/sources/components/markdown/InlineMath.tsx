import * as React from 'react';
import { Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';
import katex from 'katex';
import { injectKatexCss } from './MathRenderer';
import { KATEX_CSS_FULL } from './katex-css-full';

export const InlineMath = React.memo((props: {
    expr: string;
}) => {
    const { theme } = useUnistyles();

    // Web: full KaTeX with dangerouslySetInnerHTML
    if (Platform.OS === 'web') {
        injectKatexCss();
        let displayHtml: string;
        try {
            displayHtml = katex.renderToString(props.expr, { displayMode: false, throwOnError: false });
        } catch {
            return (
                // @ts-ignore
                <span style={{ color: theme.colors.textSecondary }}>${props.expr}$</span>
            );
        }
        const wrappedHtml = displayHtml.replace(
            /class="katex"/g,
            'class="katex" style="white-space:normal;overflow-wrap:anywhere"',
        );
        return (
            // @ts-ignore
            <span style={{ display: 'inline' }} dangerouslySetInnerHTML={{ __html: wrappedHtml }} />
        );
    }

    //
    // iOS/Android: tiny WebView rendered inside a flexWrap View (not Text).
    // Font size matches body text (16px). Height auto-measured via JS.
    //
    const [dimensions, setDimensions] = React.useState({ width: 120, height: 26 });

    let displayHtml: string;
    try {
        displayHtml = katex.renderToString(props.expr, { displayMode: false, throwOnError: false });
    } catch {
        displayHtml = `<span>${props.expr}</span>`;
    }

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <style>
        ${KATEX_CSS_FULL}
        html, body {
            margin: 0;
            padding: 0 4px;
            background-color: transparent;
            color: ${theme.colors.text};
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            font-size: 16px;
            line-height: 1.4;
        }
        #math-wrap {
            display: inline-block;
            white-space: nowrap;
        }
        .katex { font-size: 1em !important; }
        .katex-html { display: inline !important; }
    </style>
</head>
<body><span id="math-wrap">${displayHtml}</span></body>
<script>
    setTimeout(function() {
        var el = document.getElementById('math-wrap');
        var rect = el.getBoundingClientRect();
        window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'size',
            w: Math.ceil(rect.width) + 8,
            h: Math.ceil(rect.height)
        }));
    }, 400);
</script>
</html>`;

    return (
        <WebView
            source={{ html }}
            style={{
                width: dimensions.width,
                height: dimensions.height,
                backgroundColor: 'transparent',
            }}
            scrollEnabled={false}
            androidLayerType="software"
            onMessage={(event) => {
                try {
                    const data = JSON.parse(event.nativeEvent.data);
                    if (data.type === 'size' && typeof data.w === 'number' && typeof data.h === 'number') {
                        if (data.w > 0 && data.h > 0) {
                            setDimensions({ width: data.w, height: data.h });
                        }
                    }
                } catch { /* ignore */ }
            }}
        />
    );
});
