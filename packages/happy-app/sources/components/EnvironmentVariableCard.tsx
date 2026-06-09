import React from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useEnvironmentVariables } from '@/hooks/useEnvironmentVariables';

export interface EnvironmentVariableCardProps {
    variable: { name: string; value: string };
    machineId: string | null;
    expectedValue?: string;
    description?: string;
    isSecret?: boolean;
    onUpdate: (newValue: string) => void;
    onDelete: () => void;
    onDuplicate: () => void;
}

function parseVariableValue(value: string): {
    useRemoteVariable: boolean;
    remoteVariableName: string;
    defaultValue: string;
} {
    const matchWithFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*):-(.*)\}$/);
    if (matchWithFallback) {
        return { useRemoteVariable: true, remoteVariableName: matchWithFallback[1], defaultValue: matchWithFallback[2] };
    }
    const matchNoFallback = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
    if (matchNoFallback) {
        return { useRemoteVariable: true, remoteVariableName: matchNoFallback[1], defaultValue: '' };
    }
    return { useRemoteVariable: false, remoteVariableName: '', defaultValue: value };
}

export function EnvironmentVariableCard({
    variable,
    machineId,
    expectedValue,
    description,
    isSecret = false,
    onUpdate,
    onDelete,
    onDuplicate,
}: EnvironmentVariableCardProps) {
    const { theme } = useUnistyles();

    const parsed = parseVariableValue(variable.value);
    const [useRemoteVariable, setUseRemoteVariable] = React.useState(parsed.useRemoteVariable);
    const [remoteVariableName, setRemoteVariableName] = React.useState(parsed.remoteVariableName);
    const [defaultValue, setDefaultValue] = React.useState(parsed.defaultValue);

    const shouldQueryRemote = useRemoteVariable && !isSecret && remoteVariableName.trim() !== '';
    const { variables: remoteValues } = useEnvironmentVariables(
        machineId,
        shouldQueryRemote ? [remoteVariableName] : []
    );
    const remoteValue = remoteValues[remoteVariableName];

    React.useEffect(() => {
        const newValue = useRemoteVariable && remoteVariableName.trim() !== ''
            ? `\${${remoteVariableName}${defaultValue ? `:-${defaultValue}` : ''}}`
            : defaultValue;
        if (newValue !== variable.value) {
            onUpdate(newValue);
        }
    }, [useRemoteVariable, remoteVariableName, defaultValue, variable.value, onUpdate]);

    const remoteStatus = !useRemoteVariable || isSecret || !machineId || !remoteVariableName.trim()
        ? null
        : remoteValue === undefined ? 'checking'
        : remoteValue === null ? 'not-found'
        : 'found';

    return (
        <View style={cardStyles.card}>
            {/* Header: name + actions */}
            <View style={cardStyles.header}>
                <View style={cardStyles.headerLeft}>
                    {isSecret && (
                        <Ionicons name="lock-closed" size={10} color={theme.colors.textDestructive} style={{ marginRight: 4 }} />
                    )}
                    <Text style={cardStyles.varName} numberOfLines={1}>
                        {variable.name}
                    </Text>
                </View>
                <View style={cardStyles.actions}>
                    <Pressable hitSlop={10} onPress={onDuplicate}>
                        <Ionicons name="copy-outline" size={16} color={theme.colors.button.secondary.tint} />
                    </Pressable>
                    <Pressable hitSlop={10} onPress={onDelete} style={{ marginLeft: 12 }}>
                        <Ionicons name="trash-outline" size={16} color={theme.colors.deleteAction} />
                    </Pressable>
                </View>
            </View>

            {description ? (
                <Text style={cardStyles.description} numberOfLines={2}>{description}</Text>
            ) : null}

            {/* Value row: checkbox + input */}
            <View style={cardStyles.valueRow}>
                <Text style={cardStyles.label}>Value</Text>
                <TextInput
                    style={cardStyles.input}
                    placeholder={expectedValue || 'Value'}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={defaultValue}
                    onChangeText={setDefaultValue}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={isSecret}
                />
            </View>

            {/* Remote variable toggle + input (collapsed by default unless enabled) */}
            <Pressable style={cardStyles.checkRow} onPress={() => setUseRemoteVariable(!useRemoteVariable)}>
                <View style={[cardStyles.checkbox, useRemoteVariable && cardStyles.checkboxActive]}>
                    {useRemoteVariable && <Ionicons name="checkmark" size={10} color={theme.colors.button.primary.tint} />}
                </View>
                <Text style={cardStyles.checkLabel}>Copy from remote: ${'{VARIABLE}'}</Text>
            </Pressable>

            {useRemoteVariable && (
                <View style={cardStyles.remoteSection}>
                    <TextInput
                        style={cardStyles.input}
                        placeholder="Variable name (e.g., Z_AI_MODEL)"
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={remoteVariableName}
                        onChangeText={setRemoteVariableName}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    {remoteStatus === 'checking' && (
                        <Text style={cardStyles.statusText}>Checking remote...</Text>
                    )}
                    {remoteStatus === 'not-found' && (
                        <Text style={[cardStyles.statusText, { color: theme.colors.warning }]}>Value not found</Text>
                    )}
                    {remoteStatus === 'found' && (
                        <Text style={[cardStyles.statusText, { color: theme.colors.success }]}>
                            Current: {remoteValue}
                        </Text>
                    )}
                    {isSecret && (
                        <Text style={cardStyles.statusText}>Secret — not retrieved</Text>
                    )}
                    {!isSecret && !machineId && (
                        <Text style={cardStyles.statusText}>Select a machine to check</Text>
                    )}
                </View>
            )}

            {/* Session preview */}
            <Text style={cardStyles.preview} numberOfLines={1}>
                → {variable.name} = {
                    isSecret
                        ? (defaultValue ? '***' : '(empty)')
                        : (remoteStatus === 'found' ? remoteValue : (defaultValue || '(empty)'))
                }
            </Text>
        </View>
    );
}

const cardStyles = StyleSheet.create((theme) => ({
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
        marginBottom: 2,
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
        marginBottom: 6,
    },
    label: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        marginRight: theme.margins.sm,
        width: 36,
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
    checkRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    checkbox: {
        width: 16,
        height: 16,
        borderRadius: 3,
        borderWidth: 1.5,
        borderColor: theme.colors.textSecondary,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 6,
    },
    checkboxActive: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    checkLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    remoteSection: {
        marginBottom: 4,
    },
    statusText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    preview: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        marginTop: 2,
    },
}));
