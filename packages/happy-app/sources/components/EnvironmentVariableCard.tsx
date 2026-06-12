import React from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export interface EnvironmentVariableCardProps {
    variable: { name: string; value: string };
    expectedValue?: string;
    description?: string;
    isSecret?: boolean;
    onUpdate: (newValue: string) => void;
    onDelete: () => void;
    onDuplicate: () => void;
}

export function EnvironmentVariableCard({
    variable,
    expectedValue,
    description,
    isSecret = false,
    onUpdate,
    onDelete,
    onDuplicate,
}: EnvironmentVariableCardProps) {
    const { theme } = useUnistyles();
    const [showValue, setShowValue] = React.useState(false);

    return (
        <View style={styles.card}>
            {/* Header: name + actions */}
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    {isSecret && (
                        <Ionicons name="lock-closed" size={10} color={theme.colors.textDestructive} style={{ marginRight: 4 }} />
                    )}
                    <Text style={styles.varName} numberOfLines={1}>
                        {variable.name}
                    </Text>
                </View>
                <View style={styles.actions}>
                    <Pressable hitSlop={10} onPress={onDuplicate}>
                        <Ionicons name="copy-outline" size={16} color={theme.colors.button.secondary.tint} />
                    </Pressable>
                    <Pressable hitSlop={10} onPress={onDelete} style={{ marginLeft: 12 }}>
                        <Ionicons name="trash-outline" size={16} color={theme.colors.deleteAction} />
                    </Pressable>
                </View>
            </View>

            {description ? (
                <Text style={styles.description} numberOfLines={2}>{description}</Text>
            ) : null}

            <View style={styles.valueRow}>
                <TextInput
                    style={styles.input}
                    placeholder={expectedValue || 'Value'}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={variable.value}
                    onChangeText={onUpdate}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={isSecret && !showValue}
                />
                {isSecret && (
                    <Pressable
                        hitSlop={8}
                        onPress={() => setShowValue(!showValue)}
                        style={styles.eyeButton}
                    >
                        <Ionicons
                            name={showValue ? 'eye-off-outline' : 'eye-outline'}
                            size={18}
                            color={theme.colors.textSecondary}
                        />
                    </Pressable>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    card: {
        backgroundColor: theme.colors.input.background,
        borderRadius: theme.borderRadius.md,
        padding: theme.margins.sm,
        marginBottom: theme.margins.sm,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: theme.margins.sm,
    },
    varName: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        flexShrink: 1,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    description: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginBottom: 6,
        ...Typography.default(),
    },
    valueRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    input: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.sm,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: 6,
        fontSize: 13,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: theme.colors.textSecondary,
    },
    eyeButton: {
        marginLeft: 8,
        padding: 4,
    },
}));
