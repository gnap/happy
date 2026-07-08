import React from 'react';
import { View, Platform, useWindowDimensions, Pressable, Text, ScrollView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { retrieveTempText } from '@/sync/persistence';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

export default function SvgViewerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ textId?: string }>();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();

    const svgContent = React.useMemo(() => {
        if (!params.textId) return null;
        return retrieveTempText(params.textId);
    }, [params.textId]);

    // Web: direct DOM zoom/pan
    const zoomRef = React.useRef<HTMLDivElement>(null);
    const zoomState = React.useRef({ scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 });

    if (!svgContent) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.background, justifyContent: 'center', alignItems: 'center' }}>
                <Text style={{ color: theme.colors.textSecondary }}>No SVG content</Text>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
            <Stack.Screen options={{ headerTitle: 'SVG Viewer', headerBackTitle: 'Back' }} />

            {Platform.OS === 'web' ? (
                /* @ts-ignore */
                <div ref={zoomRef}
                    onMouseDown={(e: any) => {
                        zoomState.current.dragging = true;
                        zoomState.current.lastX = e.clientX;
                        zoomState.current.lastY = e.clientY;
                    }}
                    onMouseMove={(e: any) => {
                        if (!zoomState.current.dragging) return;
                        const dx = e.clientX - zoomState.current.lastX;
                        const dy = e.clientY - zoomState.current.lastY;
                        zoomState.current.x += dx;
                        zoomState.current.y += dy;
                        zoomState.current.lastX = e.clientX;
                        zoomState.current.lastY = e.clientY;
                        const el = zoomRef.current;
                        if (el) el.style.transform = `translate(${zoomState.current.x}px, ${zoomState.current.y}px) scale(${zoomState.current.scale})`;
                    }}
                    onMouseUp={() => { zoomState.current.dragging = false; }}
                    onWheel={(e: any) => {
                        e.preventDefault();
                        const delta = e.deltaY > 0 ? 0.9 : 1.1;
                        zoomState.current.scale = Math.max(0.1, Math.min(10, zoomState.current.scale * delta));
                        const el = zoomRef.current;
                        if (el) el.style.transform = `translate(${zoomState.current.x}px, ${zoomState.current.y}px) scale(${zoomState.current.scale})`;
                    }}
                    onDoubleClick={() => {
                        zoomState.current = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
                        if (zoomRef.current) zoomRef.current.style.transform = 'translate(0px, 0px) scale(1)';
                    }}
                    onClick={() => {}}
                    style={{
                        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden', cursor: zoomState.current.dragging ? 'grabbing' : 'grab',
                        backgroundColor: '#f5f5f5',
                    }}
                    dangerouslySetInnerHTML={{
                        __html: svgContent.replace(/<svg /, '<svg style="max-width:90%;max-height:90%" '),
                    }}
                />
            ) : (
                <WebView
                    source={{
                        html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes"><style>html,body{margin:0;padding:16px;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}svg{max-width:100%;height:auto}</style></head><body>${svgContent}</body></html>`,
                    }}
                    style={{ flex: 1 }}
                />
            )}
        </View>
    );
}
