import React from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { EnvironmentVariableCard } from './EnvironmentVariableCard';
import type { ProfileDocumentation } from '@/sync/profileUtils';

export interface EnvironmentVariablesListProps {
    environmentVariables: Array<{ name: string; value: string }>;
    machineId: string | null;
    profileDocs?: ProfileDocumentation | null;
    onChange: (newVariables: Array<{ name: string; value: string }>) => void;
}

export function EnvironmentVariablesList({
    environmentVariables,
    machineId,
    profileDocs,
    onChange,
}: EnvironmentVariablesListProps) {
    const { theme } = useUnistyles();

    const [showAddForm, setShowAddForm] = React.useState(false);
    const [newVarName, setNewVarName] = React.useState('');
    const [newVarValue, setNewVarValue] = React.useState('');

    const getDocumentation = React.useCallback((varName: string) => {
        if (!profileDocs) return { expectedValue: undefined, description: undefined, isSecret: false };
        const doc = profileDocs.environmentVariables.find(ev => ev.name === varName);
        return {
            expectedValue: doc?.expectedValue,
            description: doc?.description,
            isSecret: doc?.isSecret || false
        };
    }, [profileDocs]);

    const extractVarNameFromValue = React.useCallback((value: string): string | null => {
        const match = value.match(/^\$\{([A-Z_][A-Z0-9_]*)/);
        return match ? match[1] : null;
    }, []);

    const handleUpdateVariable = React.useCallback((index: number, newValue: string) => {
        const updated = [...environmentVariables];
        updated[index] = { ...updated[index], value: newValue };
        onChange(updated);
    }, [environmentVariables, onChange]);

    const handleDeleteVariable = React.useCallback((index: number) => {
        onChange(environmentVariables.filter((_, i) => i !== index));
    }, [environmentVariables, onChange]);

    const handleDuplicateVariable = React.useCallback((index: number) => {
        const envVar = environmentVariables[index];
        const baseName = envVar.name.replace(/_COPY\d*$/, '');
        let copyNum = 1;
        while (environmentVariables.some(v => v.name === `${baseName}_COPY${copyNum}`)) {
            copyNum++;
        }
        onChange([...environmentVariables, { name: `${baseName}_COPY${copyNum}`, value: envVar.value }]);
    }, [environmentVariables, onChange]);

    const handleAddVariable = React.useCallback(() => {
        if (!newVarName.trim()) return;
        if (!/^[A-Z_][A-Z0-9_]*$/.test(newVarName.trim())) return;
        if (environmentVariables.some(v => v.name === newVarName.trim())) return;
        onChange([...environmentVariables, { name: newVarName.trim(), value: newVarValue.trim() || '' }]);
        setNewVarName('');
        setNewVarValue('');
        setShowAddForm(false);
    }, [newVarName, newVarValue, environmentVariables, onChange]);

    return (
        <View style={listStyles.container}>
            <Text style={listStyles.sectionTitle}>Environment Variables</Text>

            <Pressable style={listStyles.addButton} onPress={() => setShowAddForm(true)}>
                <Ionicons name="add" size={14} color={theme.colors.button.primary.tint} />
                <Text style={listStyles.addButtonText}>Add Variable</Text>
            </Pressable>

            {showAddForm && (
                <View style={listStyles.addForm}>
                    <TextInput
                        style={listStyles.addInput}
                        placeholder="Variable name (e.g., MY_CUSTOM_VAR)"
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={newVarName}
                        onChangeText={setNewVarName}
                        autoCapitalize="characters"
                        autoCorrect={false}
                    />
                    <TextInput
                        style={listStyles.addInput}
                        placeholder="Value (e.g., my-value or ${VAR})"
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={newVarValue}
                        onChangeText={setNewVarValue}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <View style={listStyles.addFormActions}>
                        <Pressable style={listStyles.addFormCancel} onPress={() => {
                            setShowAddForm(false);
                            setNewVarName('');
                            setNewVarValue('');
                        }}>
                            <Text style={listStyles.addFormCancelText}>Cancel</Text>
                        </Pressable>
                        <Pressable style={listStyles.addFormSubmit} onPress={handleAddVariable}>
                            <Text style={listStyles.addFormSubmitText}>Add</Text>
                        </Pressable>
                    </View>
                </View>
            )}

            {environmentVariables.map((envVar, index) => {
                const varNameFromValue = extractVarNameFromValue(envVar.value);
                const docs = getDocumentation(varNameFromValue || envVar.name);
                const isSecret = docs.isSecret || /TOKEN|KEY|SECRET|AUTH/i.test(envVar.name) || /TOKEN|KEY|SECRET|AUTH/i.test(varNameFromValue || '');

                return (
                    <EnvironmentVariableCard
                        key={index}
                        variable={envVar}
                        machineId={machineId}
                        expectedValue={docs.expectedValue}
                        description={docs.description}
                        isSecret={isSecret}
                        onUpdate={(newValue) => handleUpdateVariable(index, newValue)}
                        onDelete={() => handleDeleteVariable(index)}
                        onDuplicate={() => handleDuplicateVariable(index)}
                    />
                );
            })}
        </View>
    );
}

const listStyles = StyleSheet.create((theme) => ({
    container: {
        marginBottom: theme.margins.md,
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    addButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: theme.borderRadius.md,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: 5,
        gap: 4,
        marginBottom: theme.margins.sm,
        alignSelf: 'flex-start',
    },
    addButtonText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
    addForm: {
        backgroundColor: theme.colors.input.background,
        borderRadius: theme.borderRadius.md,
        padding: theme.margins.sm,
        marginBottom: theme.margins.sm,
        borderWidth: 1.5,
        borderColor: theme.colors.button.primary.background,
    },
    addInput: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.sm,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: 6,
        fontSize: 13,
        color: theme.colors.text,
        marginBottom: theme.margins.xs,
        borderWidth: 1,
        borderColor: theme.colors.textSecondary,
    },
    addFormActions: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 4,
    },
    addFormCancel: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.sm,
        paddingVertical: 6,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: theme.colors.textSecondary,
    },
    addFormCancelText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    addFormSubmit: {
        flex: 1,
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: theme.borderRadius.sm,
        paddingVertical: 6,
        alignItems: 'center',
    },
    addFormSubmitText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
}));
