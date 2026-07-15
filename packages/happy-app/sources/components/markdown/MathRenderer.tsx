import * as React from 'react';
import { View, Platform, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import katex from 'katex';
import { KATEX_CSS_FULL } from './katex-css-full';

let katexCssInjected = false;
export function injectKatexCss() {
    if (typeof document === 'undefined') return; // SSR guard
    if (katexCssInjected) return;
    const style = document.createElement('style');
    // Use full CSS with @font-face rules, rewriting font URLs to CDN so glyphs
    // like braces, brackets, and big operators render correctly on web.
    const CDN_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/fonts/';
    style.textContent = KATEX_CSS_FULL.replace(
        /url\(fonts\/([^)]+)\)/g,
        `url(${CDN_BASE}$1)`,
    );
    document.head.appendChild(style);
    katexCssInjected = true;
}

export const MathRenderer = React.memo((props: {
    content: string;
}) => {
    const { theme } = useUnistyles();
    const { width: screenWidth } = useWindowDimensions();
    const [webViewHeight, setWebViewHeight] = React.useState(100);
    const containerRef = React.useRef<View>(null);

    // Use screen width minus some padding as the WebView width.
    // iOS WKWebView doesn't support percentage widths, so we use pixel values.
    const containerWidth = screenWidth > 0 ? Math.floor(screenWidth) - 32 : 300;

    // Measure constrained ancestor width (JS) to prevent KaTeX overflow pushing layout
    const [measuredWidth, setMeasuredWidth] = React.useState(0);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !containerRef.current) return;
        const el = (containerRef.current as any) as HTMLElement;
        let parent = el.parentElement;
        while (parent) {
            const cs = getComputedStyle(parent);
            if (cs.maxWidth !== 'none' && cs.maxWidth !== '0px' && !cs.maxWidth.includes('%')) {
                const w = parent.getBoundingClientRect().width;
                if (w > 0) { setMeasuredWidth(w); return; }
            }
            parent = parent.parentElement;
        }
        if (el.parentElement) setMeasuredWidth(el.parentElement.getBoundingClientRect().width);
    }, []);

    //
    // Web
    //
    if (Platform.OS === 'web') {
        injectKatexCss();
        let html: string;
        try {
            html = katex.renderToString(props.content, { displayMode: true, throwOnError: false });
        } catch {
            html = `<span style="color:${theme.colors.textSecondary}">${props.content}</span>`;
        }
        const w = measuredWidth > 0 ? measuredWidth : containerWidth;
        return (
            <View ref={containerRef} style={style.container}>
                {/* @ts-ignore */}
                <div style={{
                    display: 'flex', justifyContent: 'center', alignItems: 'center',
                    padding: 16, width: w, maxWidth: w,
                    overflowX: 'auto', overflowY: 'hidden',
                }} dangerouslySetInnerHTML={{ __html: html }} />
            </View>
        );
    }

    //
    // iOS/Android
    //
    let displayHtml: string;
    try {
        displayHtml = katex.renderToString(props.content, { displayMode: true, throwOnError: false });
    } catch {
        displayHtml = `<span>${props.content}</span>`;
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
            padding: 16px;
            background-color: ${theme.colors.surfaceHighest};
            color: ${theme.colors.text};
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            font-size: 14px;
        }
        .katex { font-size: 1em !important; }
        .katex-display { margin: 0 !important; }
        .math-container { text-align: center; }
    </style>
</head>
<body>
    <div class="math-container">${displayHtml}</div>
    <script>
        // Measure after fonts & layout settle. Use the max of multiple methods.
        setTimeout(function() {
            var h = Math.max(
                document.body.scrollHeight,
                document.body.offsetHeight,
                document.documentElement.scrollHeight,
                document.documentElement.offsetHeight
            );
            window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'dimensions',
                height: h
            }));
        }, 300);
    </script>
</body>
</html>`;

    // Dynamic WebView import (unsupported on Linux/Tauri)
    const [WebViewComp, setWebViewComp] = React.useState<any>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'web') {
            import('react-native-webview').then(m => setWebViewComp(() => m.WebView));
        }
    }, []);
    if (!WebViewComp) {
        return <View ref={containerRef} style={[style.container, { height: 100 }]} />;
    }
    return (
        <View ref={containerRef} style={style.container}>
            <WebViewComp
                source={{ html }}
                style={{ width: containerWidth, height: webViewHeight }}
                scrollEnabled={true}
                nestedScrollEnabled={true}
                showsVerticalScrollIndicator={false}
                onMessage={(event: any) => {
                    try {
                        const data = JSON.parse(event.nativeEvent.data);
                        if (data.type === 'dimensions' && typeof data.height === 'number') {
                            const h = data.height;
                            if (h > 0 && h !== webViewHeight) setWebViewHeight(h);
                        }
                    } catch { /* ignore */ }
                }}
            />
        </View>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
}));
