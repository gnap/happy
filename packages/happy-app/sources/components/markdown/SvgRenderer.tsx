import * as React from 'react';
import { View, Platform, useWindowDimensions, Pressable } from 'react-native';
import { WebView } from 'react-native-webview';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { storeTempText } from '@/sync/persistence';

export const SvgRenderer = React.memo((props: {
    content: string;
}) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { width: screenWidth } = useWindowDimensions();
    const [webViewHeight, setWebViewHeight] = React.useState(100);
    const containerWidth = screenWidth > 0 ? Math.floor(screenWidth) - 32 : 300;

    const handlePress = React.useCallback(() => {
        const textId = storeTempText(props.content);
        router.push(`/svg-viewer?textId=${textId}`);
    }, [props.content, router]);

    // Web: render SVG directly via dangerouslySetInnerHTML
    if (Platform.OS === 'web') {
        const wrappedSvg = props.content.replace(
            /<svg /,
            '<svg style="width:100%!important;max-width:100%!important;height:auto!important;display:block" ',
        );
        return (
            <View style={style.container}>
                {/* @ts-ignore */}
                <div
                    onClick={(e) => { e.stopPropagation(); handlePress(); }}
                    style={{
                        display: 'flex', justifyContent: 'center', alignItems: 'center',
                        padding: 16, maxWidth: '100%', overflowX: 'auto', overflowY: 'hidden',
                        backgroundColor: theme.colors.surfaceHighest, borderRadius: 8,
                        cursor: 'pointer',
                    }}
                    dangerouslySetInnerHTML={{ __html: wrappedSvg }}
                />
            </View>
        );
    }

    // iOS/Android: render SVG in a WebView, tap to open viewer page.
    // Use static import — dynamic import() caused issues on iOS.
    // On platforms without react-native-webview (Linux/Tauri), we fall back
    // to the web path above via Platform.OS === 'web'.

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <style>
        html, body {
            margin: 0; padding: 16px;
            background-color: ${theme.colors.surfaceHighest};
            display: flex; justify-content: center; align-items: center;
        }
        svg { width: 100% !important; max-width: 100% !important; height: auto !important; display: block; }
    </style>
</head>
<body>
    ${props.content}
    <script>
        setTimeout(function() {
            var h = Math.max(document.body.scrollHeight, document.body.offsetHeight,
                document.documentElement.scrollHeight, document.documentElement.offsetHeight);
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dimensions', height: h }));
        }, 100);
    </script>
</body>
</html>`;

    return (
        <Pressable onPress={handlePress}>
            <View style={style.container}>
                <WebView
                    source={{ html }}
                    style={{ width: containerWidth, height: webViewHeight }}
                    scrollEnabled={false}
                    showsVerticalScrollIndicator={false}
                    pointerEvents="none"
                    onMessage={(event) => {
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
        </Pressable>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
}));
