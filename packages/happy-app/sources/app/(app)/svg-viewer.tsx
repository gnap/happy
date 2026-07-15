import React from 'react';
import { View, Platform, useWindowDimensions, Text } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { retrieveTempText } from '@/sync/persistence';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export default function SvgViewerScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ textId?: string; type?: string }>();
    const { width: screenWidth } = useWindowDimensions();
    const containerWidth = screenWidth > 0 ? Math.floor(screenWidth) - 32 : 300;

    const content = React.useMemo(() => {
        if (!params.textId) return null;
        return retrieveTempText(params.textId);
    }, [params.textId]);

    const isMermaid = params.type === 'mermaid';

    if (!content) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.surface, justifyContent: 'center', alignItems: 'center' }}>
                <Text style={{ color: theme.colors.textSecondary }}>No content</Text>
            </View>
        );
    }

    const title = isMermaid ? 'Mermaid' : 'SVG';

    // Build HTML for the WebView
    let html: string;
    if (isMermaid) {
        html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    <style>
        html,body{margin:0;padding:16px;background:${theme.colors.surface};display:flex;align-items:center;justify-content:center;min-height:100vh}
        .mermaid{width:100%;text-align:center}
        .mermaid svg{max-width:100%!important;height:auto!important}
    </style>
</head>
<body>
    <div class="mermaid">${content}</div>
    <script>
        mermaid.initialize({startOnLoad:true,theme:'default'});
    </script>
</body>
</html>`;
    } else {
        html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
    <style>
        html,body{margin:0;padding:16px;background:${theme.colors.surface};display:flex;align-items:center;justify-content:center;min-height:100vh}
        svg{max-width:100%!important;height:auto!important}
    </style>
</head>
<body>${content}</body>
</html>`;
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            <Stack.Screen options={{ headerTitle: `${title} Viewer`, headerBackTitle: 'Back' }} />

            {isMermaid && Platform.OS === 'web' ? (
                /* @ts-ignore */
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: 16 }}
                    dangerouslySetInnerHTML={{
                        __html: `<div style="width:100%"><div class="mermaid">${content}</div><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script><script>mermaid.initialize({startOnLoad:true,theme:'default'});</script></div>`,
                    }}
                />
            ) : Platform.OS === 'web' ? null : (
                <NativeSvgViewer html={html} />
            )}
        </View>
    );
}

// Thin wrapper that dynamically imports react-native-webview (unsupported on Linux/Tauri)
function NativeSvgViewer({ html }: { html: string }) {
    const [WebViewComp, setWebViewComp] = React.useState<any>(null);
    React.useEffect(() => {
        import('react-native-webview').then(m => setWebViewComp(() => m.WebView));
    }, []);
    if (!WebViewComp) return null;
    return <WebViewComp source={{ html }} style={{ flex: 1 }} scrollEnabled={true} />;
}
