import * as React from 'react';
import { View, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import katex from 'katex';

const webStyle: any = {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
    overflow: 'auto',
};

export const MathRenderer = React.memo((props: {
    content: string;
}) => {
    const { theme } = useUnistyles();
    const [dimensions, setDimensions] = React.useState({ width: 0, height: 60 });

    const onLayout = React.useCallback((event: any) => {
        const { width } = event.nativeEvent.layout;
        setDimensions(prev => ({ ...prev, width }));
    }, []);

    // Web platform: use katex.renderToString + dangerouslySetInnerHTML (instant, no WebView)
    if (Platform.OS === 'web') {
        let html: string;
        try {
            html = katex.renderToString(props.content, {
                displayMode: true,
                throwOnError: false,
            });
        } catch {
            html = `<span style="color:${theme.colors.textSecondary}">${props.content}</span>`;
        }

        return (
            <View style={style.container}>
                {/* @ts-ignore - Web only */}
                <div
                    style={webStyle}
                    dangerouslySetInnerHTML={{ __html: html }}
                />
            </View>
        );
    }

    // iOS/Android: WebView with auto-sizing
    const color = theme.colors.text;

    // Generate HTML string via katex on the JS side, embed in WebView
    let displayHtml: string;
    try {
        displayHtml = katex.renderToString(props.content, {
            displayMode: true,
            throwOnError: false,
        });
    } catch {
        displayHtml = `<span style="color:${theme.colors.textSecondary}">${props.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`;
    }

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    margin: 0;
                    padding: 16px;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    background-color: transparent;
                    color: ${color};
                }
                .katex { font-size: 1.1em; }
                .katex-display { margin: 0; }
                .katex-html { display: flex; align-items: center; }
            </style>
        </head>
        <body>
            ${displayHtml}
        </body>
        </html>
    `;

    return (
        <View style={style.container} onLayout={onLayout}>
            <View style={[style.innerContainer, { height: Math.max(60, dimensions.height) }]}>
                <WebView
                    source={{ html }}
                    style={{ flex: 1, backgroundColor: 'transparent' }}
                    scrollEnabled={false}
                    onMessage={(event) => {
                        try {
                            const data = JSON.parse(event.nativeEvent.data);
                            if (data.type === 'dimensions') {
                                setDimensions(prev => ({
                                    ...prev,
                                    height: Math.max(60, data.height + 32),
                                }));
                            }
                        } catch { /* ignore */ }
                    }}
                    injectedJavaScript={`
                        setTimeout(() => {
                            window.ReactNativeWebView.postMessage(JSON.stringify({
                                type: 'dimensions',
                                height: document.body.scrollHeight
                            }));
                        }, 100);
                    `}
                />
            </View>
        </View>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
    innerContainer: {
        width: '100%',
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
    },
}));
