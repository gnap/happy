import * as React from 'react';
import { ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
    /** Draws this glyph instead of a plain dot, keeping the same colour and pulse. */
    icon?: React.ComponentProps<typeof Ionicons>['name'];
}

export const StatusDot = React.memo(({ color, isPulsing, size = 6, style, icon }: StatusDotProps) => {
    const opacity = useSharedValue(1);

    React.useEffect(() => {
        if (isPulsing) {
            opacity.value = withRepeat(
                withTiming(0.3, { duration: 1000 }),
                -1, // infinite
                true // reverse
            );
        } else {
            opacity.value = withTiming(1, { duration: 200 });
        }
    }, [isPulsing]);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: opacity.value,
        };
    });

    if (icon) {
        return (
            <Animated.View style={[animatedStyle, style]}>
                <Ionicons name={icon} size={size} color={color} />
            </Animated.View>
        );
    }

    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <Animated.View
            style={[
                baseStyle,
                animatedStyle,
                style
            ]}
        />
    );
});