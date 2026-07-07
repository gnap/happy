import React from 'react';
import { View, Text, Pressable, TextInput, Modal, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { EnvironmentVariableCard } from './EnvironmentVariableCard';
import * as Clipboard from 'expo-clipboard';
import type { ProfileDocumentation } from '@/sync/profileUtils';

export interface EnvironmentVariablesListProps {
    environmentVariables: Array<{ name: string; value: string }>;
    profileDocs?: ProfileDocumentation | null;
    onChange: (newVariables: Array<{ name: string; value: string }>) => void;
}

export function EnvironmentVariablesList({
    environmentVariables,
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

    // Auto-detect env vars from clipboard on mount (only when entering the edit page)
    React.useEffect(() => {
        void (async () => {
            try {
                const text = await Clipboard.getStringAsync();
                if (!text) return;
                const parsed = parseEnvVarsFromText(text);
                if (parsed.length > 0) {
                    setClipboardPreview(parsed);
                }
            } catch (e) {
                console.warn('[clipboard] Failed to read clipboard:', e);
            }
        })();
    }, [parseEnvVarsFromText]);

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
        onChange([...environmentVariables, { name: newVarName.trim(), value: newVarValue }]);
        setNewVarName('');
        setNewVarValue('');
        setShowAddForm(false);
    }, [newVarName, newVarValue, environmentVariables, onChange]);

    // Clipboard import
    const [clipboardPreview, setClipboardPreview] = React.useState<Array<{ name: string; value: string }> | null>(null);

    const parseEnvVarsFromText = React.useCallback((text: string): Array<{ name: string; value: string }> => {
        const result: Array<{ name: string; value: string }> = [];
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            // Match: export VAR=value, export VAR="value", VAR=value, VAR="value", VAR=value with spaces, VAR='value'
            const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/);
            if (m) {
                const name = m[1].toUpperCase();
                const value = m[2] ?? m[3] ?? (m[4] ?? '').trim();
                if (!result.some(v => v.name === name)) {
                    result.push({ name, value });
                }
            }
        }
        return result;
    }, []);

    const handlePaste = React.useCallback(async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (!text) return;
            const parsed = parseEnvVarsFromText(text);
            if (parsed.length > 0) {
                setClipboardPreview(parsed);
            }
        } catch (e) {
            console.warn('[clipboard] Paste failed:', e);
        }
    }, [parseEnvVarsFromText]);

    const handleConfirmImport = React.useCallback(() => {
        if (!clipboardPreview) return;
        const merged = [...environmentVariables];
        for (const v of clipboardPreview) {
            const idx = merged.findIndex(e => e.name === v.name);
            if (idx >= 0) {
                merged[idx] = v; // update existing
            } else {
                merged.push(v);
            }
        }
        onChange(merged);
        setClipboardPreview(null);
    }, [clipboardPreview, environmentVariables, onChange]);

    return (
        <View style={styles.container}>
            <Text style={styles.sectionTitle}>Environment Variables</Text>

            <View style={styles.buttonRow}>
                <Pressable style={styles.addButton} onPress={() => setShowAddForm(true)}>
                    <Ionicons name="add" size={14} color={theme.colors.button.primary.tint} />
                    <Text style={styles.addButtonText}>Add Variable</Text>
                </Pressable>
                <Pressable style={styles.pasteButton} onPress={() => handlePaste()}>
                    <Ionicons name="clipboard-outline" size={14} color={theme.colors.button.secondary.tint} />
                    <Text style={styles.pasteButtonText}>Paste from Clipboard</Text>
                </Pressable>
            </View>

            {showAddForm && (
                <View style={styles.addForm}>
                    <TextInput
                        style={styles.addInput}
                        placeholder="Variable name (e.g., MY_CUSTOM_VAR)"
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={newVarName}
                        onChangeText={setNewVarName}
                        autoCapitalize="characters"
                        autoCorrect={false}
                    />
                    <TextInput
                        style={styles.addInput}
                        placeholder="Value"
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={newVarValue}
                        onChangeText={setNewVarValue}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <View style={styles.addFormActions}>
                        <Pressable style={styles.addFormCancel} onPress={() => {
                            setShowAddForm(false);
                            setNewVarName('');
                            setNewVarValue('');
                        }}>
                            <Text style={styles.addFormCancelText}>Cancel</Text>
                        </Pressable>
                        <Pressable style={styles.addFormSubmit} onPress={handleAddVariable}>
                            <Text style={styles.addFormSubmitText}>Add</Text>
                        </Pressable>
                    </View>
                </View>
            )}

            {environmentVariables.map((envVar, index) => {
                const docs = getDocumentation(envVar.name);
                const isSecret = docs.isSecret || /TOKEN|KEY|SECRET|AUTH/i.test(envVar.name);

                return (
                    <EnvironmentVariableCard
                        key={index}
                        variable={envVar}
                        expectedValue={docs.expectedValue}
                        description={docs.description}
                        isSecret={isSecret}
                        onUpdate={(newValue) => handleUpdateVariable(index, newValue)}
                        onDelete={() => handleDeleteVariable(index)}
                        onDuplicate={() => handleDuplicateVariable(index)}
                    />
                );
            })}
            {/* Clipboard import preview modal */}
            <Modal
                visible={clipboardPreview !== null}
                transparent
                animationType="fade"
                onRequestClose={() => setClipboardPreview(null)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>
                            {clipboardPreview ? `Found ${clipboardPreview.length} variable${clipboardPreview.length !== 1 ? 's' : ''}` : ''}
                        </Text>
                        <ScrollView style={styles.modalList}>
                            {clipboardPreview?.map((v, i) => (
                                <View key={i} style={styles.modalItem}>
                                    <Text style={styles.modalItemName}>{v.name}</Text>
                                    <Text style={styles.modalItemValue} numberOfLines={1}>{v.value || '(empty)'}</Text>
                                </View>
                            ))}
                        </ScrollView>
                        <View style={styles.modalActions}>
                            <Pressable style={styles.modalCancel} onPress={() => setClipboardPreview(null)}>
                                <Text style={styles.modalCancelText}>Cancel</Text>
                            </Pressable>
                            <Pressable style={styles.modalConfirm} onPress={handleConfirmImport}>
                                <Text style={styles.modalConfirmText}>Import</Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
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
    buttonRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: theme.margins.sm,
    },
    addButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: theme.borderRadius.md,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: 5,
        gap: 4,
    },
    pasteButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.button.secondary.background,
        borderRadius: theme.borderRadius.md,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: 5,
        gap: 4,
    },
    addButtonText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
    pasteButtonText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.button.secondary.tint,
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
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    modalContent: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.xl,
        padding: 20,
        width: '100%',
        maxWidth: 400,
        maxHeight: '70%',
    },
    modalTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 12,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    modalList: {
        maxHeight: 300,
        marginBottom: 16,
    },
    modalItem: {
        flexDirection: 'row',
        paddingVertical: 8,
        borderBottomWidth: 0.5,
        borderBottomColor: theme.colors.textSecondary + '40',
    },
    modalItemName: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        width: 140,
        ...Typography.default('semiBold'),
    },
    modalItemValue: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        flex: 1,
        ...Typography.default(),
    },
    modalActions: {
        flexDirection: 'row',
        gap: 10,
    },
    modalCancel: {
        flex: 1,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: theme.borderRadius.sm,
        paddingVertical: 10,
        alignItems: 'center',
    },
    modalCancelText: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.button.secondary.tint,
        ...Typography.default('semiBold'),
    },
    modalConfirm: {
        flex: 1,
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: theme.borderRadius.sm,
        paddingVertical: 10,
        alignItems: 'center',
    },
    modalConfirmText: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
}));
