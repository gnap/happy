import * as React from 'react';
import { View, Platform, Text, useWindowDimensions, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { storeTempText } from '@/sync/persistence';
import { useRouter } from 'expo-router';

// Style for Web platform
const webStyle: any = {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 16,
    overflow: 'auto',
};

// Mermaid render component that works on all platforms
export const MermaidRenderer = React.memo((props: {
    content: string;
}) => {
    const { theme } = useUnistyles();
    const { width: screenWidth } = useWindowDimensions();
    const router = useRouter();
    const [webViewHeight, setWebViewHeight] = React.useState(400);
    const [svgContent, setSvgContent] = React.useState<string | null>(null);

    const containerWidth = screenWidth > 0 ? Math.floor(screenWidth) - 32 : 300;

    const handlePress = React.useCallback(() => {
        const textId = storeTempText(props.content);
        router.push(`/svg-viewer?textId=${textId}&type=mermaid`);
    }, [props.content, router]);

    // Web platform uses direct SVG rendering
    if (Platform.OS === 'web') {
        const [hasError, setHasError] = React.useState(false);

        React.useEffect(() => {
            let isMounted = true;
            setHasError(false);

            const renderMermaid = async () => {
                try {
                    const mermaidModule: any = await import('mermaid');
                    const mermaid = mermaidModule.default || mermaidModule;

                    if (mermaid.initialize) {
                        mermaid.initialize({
                            startOnLoad: false,
                            theme: 'dark'
                        });
                    }

                    if (mermaid.render) {
                        const { svg } = await mermaid.render(
                            `mermaid-${Date.now()}`,
                            props.content
                        );

                        if (isMounted) {
                            setSvgContent(svg);
                        }
                    }
                } catch (error) {
                    if (isMounted) {
                        console.warn(`[Mermaid] ${t('markdown.mermaidRenderFailed')}: ${error instanceof Error ? error.message : String(error)}`);
                        setHasError(true);
                    }
                }
            };

            renderMermaid();

            return () => {
                isMounted = false;
            };
        }, [props.content]);

        if (hasError) {
            return (
                <View style={[style.container, style.errorContainer]}>
                    <View style={style.errorContent}>
                        <Text style={style.errorText}>Mermaid diagram syntax error</Text>
                        <View style={style.codeBlock}>
                            <Text style={style.codeText}>{props.content}</Text>
                        </View>
                    </View>
                </View>
            );
        }

        if (!svgContent) {
            return (
                <View style={[style.container, style.loadingContainer]}>
                    <View style={style.loadingPlaceholder} />
                </View>
            );
        }

        return (
            <View style={style.container}>
                {/* @ts-ignore - Web only */}
                <div
                    style={webStyle}
                    dangerouslySetInnerHTML={{ __html: svgContent }}
                />
            </View>
        );
    }

    // iOS/Android: WebView with CDN mermaid
    // Use require() with try-catch — dynamic import() fails silently on iOS
    let WebViewComp: any = null;
    if (Platform.OS !== 'web') {
        try { WebViewComp = require('react-native-webview').WebView; } catch { /* unsupported */ }
    }

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
            <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
            <style>
                body { margin: 0; padding: 16px; background-color: ${theme.colors.surfaceHighest}; }
                #mermaid-container { display: flex; justify-content: center; align-items: center; width: 100%; }
                .mermaid { text-align: center; width: 100%; }
                .mermaid svg { max-width: 100%; height: auto; }
            </style>
        </head>
        <body>
            <div id="mermaid-container" class="mermaid">${props.content}</div>
            <script>
                mermaid.initialize({ startOnLoad: true, theme: 'dark' });
                setTimeout(function() {
                    var h = Math.max(document.body.scrollHeight, document.body.offsetHeight);
                    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dimensions', height: h }));
                }, 300);
            </script>
        </body>
        </html>
    `;

    if (!WebViewComp) {
        return <View style={[style.container, { height: 100 }]} />;
    }

    return (
        <Pressable onPress={handlePress}>
            <View style={style.container}>
                <WebViewComp
                    source={{ html }}
                    style={{ width: containerWidth, height: webViewHeight, borderRadius: 8 }}
                    scrollEnabled={false}
                    onMessage={(event: any) => {
                        try {
                            const data = JSON.parse(event.nativeEvent.data);
                            if (data.type === 'dimensions') setWebViewHeight(prev => Math.max(prev, data.height));
                        } catch { /* ignore */ }
                    }}
                />
                <View style={style.tapHint}>
                    <Text style={style.tapHintText}>Tap to view full diagram</Text>
                </View>
            </View>
        </Pressable>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
    loadingContainer: {
        justifyContent: 'center',
        alignItems: 'center',
        height: 100,
    },
    loadingPlaceholder: {
        width: 200,
        height: 20,
        backgroundColor: theme.colors.divider,
        borderRadius: 4,
    },
    errorContainer: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        padding: 16,
    },
    errorContent: {
        flexDirection: 'column',
        gap: 12,
    },
    errorText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 16,
    },
    codeBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 4,
        padding: 12,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
    tapHint: {
        alignItems: 'center',
        paddingVertical: 4,
    },
    tapHintText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
