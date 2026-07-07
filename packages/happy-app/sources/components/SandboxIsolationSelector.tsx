import React from 'react';
import { Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

interface SandboxIsolationSelectorProps {
    currentIsolation: string;
    onPress: () => void;
}

/** Shield icon button that opens the sandbox picker overlay (handled in AgentInput). */
export function SandboxIsolationSelector({
    currentIsolation,
    onPress,
}: SandboxIsolationSelectorProps) {
    const { theme } = useUnistyles();
    const active = currentIsolation !== 'off';

    return (
        <Pressable
            onPress={() => {
                onPress();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                justifyContent: 'center',
                height: 32,
                opacity: p.pressed ? 0.7 : 1,
            })}
        >
            <Ionicons
                name={active ? 'shield-checkmark-outline' : 'shield-outline'}
                size={16}
                color={active ? '#34C759' : theme.colors.button.secondary.tint}
            />
        </Pressable>
    );
}

/** Sandbox isolation options for the picker overlay. */
export const SANDBOX_ISOLATION_OPTIONS = [
    { key: 'off', nameKey: 'sandbox.isolation.off', descKey: 'sandbox.isolationOffDesc' },
    { key: 'strict', nameKey: 'sandbox.isolation.strict', descKey: 'sandbox.isolationStrictDesc' },
    { key: 'workspace', nameKey: 'sandbox.isolation.workspace', descKey: 'sandbox.isolationWorkspaceDesc' },
    { key: 'custom', nameKey: 'sandbox.isolation.custom', descKey: 'sandbox.isolationCustomDesc' },
] as const;
