import { useHeaderHeight } from '@/utils/responsive';
import * as React from 'react';
import { Keyboard, View } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({ input, content, placeholder }) => {
    const safeArea = useSafeAreaInsets();
    const height = useReanimatedKeyboardAnimation();
    const headerHeight = useHeaderHeight();
    /**
     * The keyboard height as React Native itself reported it, used only when the controller's
     * animation reports nothing.
     *
     * Measured on a device: the first show after a screen mounts arrives as `height=0,
     * progress=0` and never corrects — the content does not move and the keyboard covers it;
     * every later show reports 361. The fixed value is not an animation, but a first summon that
     * jumps into place is the correct outcome, and the controller takes over from the second one.
     */
    const fallbackHeight = useSharedValue(0);
    React.useEffect(() => {
        const show = Keyboard.addListener('keyboardWillShow', (event) => {
            fallbackHeight.value = -event.endCoordinates.height;
        });
        const hide = Keyboard.addListener('keyboardWillHide', () => {
            fallbackHeight.value = 0;
        });
        return () => {
            show.remove();
            hide.remove();
        };
    }, []);
    /**
     * The screen is resized, not shifted.
     *
     * The first version translated the content and the input up by the keyboard's height and
     * compensated with a negative top padding. The numbers were right (`height=-361, progress=1`
     * measured on a device) and the input still ended up behind the keyboard: a translation moves
     * the *view* while the list keeps its height, so its bottom stays under the keyboard — the
     * "window does not resize" shape. Padding the container's bottom is what actually takes the
     * space away, and the list and input lay themselves out again above the keyboard.
     */
    const resizeStyle = useAnimatedStyle(() => {
        // The shared values are read directly here: Reanimated records the dependencies it can see
        // in the worklet body, and a helper function reading them is invisible to that scan — the
        // padding then never recomputes, which is how a measured fallback height did nothing.
        // Only a negative height is the controller reporting the keyboard's offset. Zero — whatever
        // the progress says — is the controller with nothing to say, which it does on some layout
        // passes while the keyboard is still up; trusting it there drops the padding and pushes the
        // composer back under the keyboard. The RN event's height is the fallback for exactly that.
        const reported = height.height.value;
        const h = reported < 0 ? reported : fallbackHeight.value;
        return { paddingBottom: Math.max(0, -h) };
    });
    return (
        <Animated.View style={[{ flexBasis: 0, flexGrow: 1 }, resizeStyle]}>
            <View style={{ flexBasis: 0, flexGrow: 1 }}>
                {content && (
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                        {content}
                    </View>
                )}
                {placeholder && (
                    <Animated.ScrollView
                        style={{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }}
                        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </Animated.ScrollView>
                )}
            </View>
            <View>
                {input}
            </View>
        </Animated.View>
    );
});

// const FallbackKeyboardAvoidingView: React.FC<AgentContentViewProps> = React.memo(({
//     children,
// }) => {
    
// });