import * as React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withRepeat,
    withTiming,
    interpolate,
    Easing,
    useAnimatedRef,
    measure,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

interface ShimmerViewProps {
    children: React.ReactNode;
    shimmerColors?: readonly [string, string, ...string[]];
    shimmerWidthPercent?: number;
    duration?: number;
    style?: ViewStyle;
}

export const ShimmerView = React.memo<ShimmerViewProps>(({
    children,
    shimmerColors = ['#E0E0E0', '#F0F0F0', '#F8F8F8', '#F0F0F0', '#E0E0E0'],
    shimmerWidthPercent = 80,
    duration = 1500,
    style,
}) => {
    const shimmerTranslate = useSharedValue(0);
    const containerRef = useAnimatedRef<View>();

    React.useEffect(() => {
        shimmerTranslate.value = withRepeat(
            withTiming(1, {
                duration,
                easing: Easing.linear,
            }),
            -1,
            false
        );
    }, [duration]);

    const animatedStyle = useAnimatedStyle(() => {
        const measured = measure(containerRef);
        const width = measured ? measured.width : 0;
        const shimmerWidth = width * (shimmerWidthPercent / 100);
        const translateX = interpolate(
            shimmerTranslate.value,
            [0, 1],
            [-shimmerWidth, width]
        );
        return {
            transform: [{ translateX }],
        };
    });

    return (
        <Animated.View ref={containerRef} style={style}>
            {/* Render invisible children first to establish size */}
            <View style={styles.hiddenChildren}>
                {children}
            </View>
            
            {/* Shimmer overlay */}
            <MaskedView
                style={styles.absoluteFill}
                maskElement={
                    <View style={styles.maskContainer}>
                        {children}
                    </View>
                }
            >
                {/* Base background */}
                <View style={[styles.absoluteFill, styles.background]} />

                {/* Animated shimmer */}
                <AnimatedLinearGradient
                    colors={shimmerColors}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={[
                        styles.absoluteFill,
                        animatedStyle,
                    ]}
                />
            </MaskedView>
        </Animated.View>
    );
});

const styles = StyleSheet.create({
    /**
     * RN 0.86 dropped `StyleSheet.absoluteFillObject` from its types; this is the same object.
     * A local style keeps the component independent of that API's presence in the native types.
     */
    absoluteFill: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    maskContainer: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    background: {
        backgroundColor: '#E0E0E0',
    },
    hiddenChildren: {
        opacity: 0,
    },
});