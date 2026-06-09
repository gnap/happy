import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ViewStyle, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AIBackendProfile } from '@/sync/settings';
import { getBuiltInProfileDocumentation } from '@/sync/profileUtils';
import { useEnvironmentVariables, extractEnvVarReferences } from '@/hooks/useEnvironmentVariables';
import { EnvironmentVariablesList } from '@/components/EnvironmentVariablesList';

export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    machineId: string | null;
    onSave: (profile: AIBackendProfile) => void;
    onCancel: () => void;
    containerStyle?: ViewStyle;
}

export function ProfileEditForm({
    profile,
    machineId,
    onSave,
    onCancel,
    containerStyle
}: ProfileEditFormProps) {
    const { theme } = useUnistyles();

    const profileDocs = React.useMemo(() => {
        if (!profile.isBuiltIn) return null;
        return getBuiltInProfileDocumentation(profile.id);
    }, [profile.isBuiltIn, profile.id]);

    const [environmentVariables, setEnvironmentVariables] = React.useState<Array<{ name: string; value: string }>>(
        profile.environmentVariables || []
    );

    const envVarNames = React.useMemo(() => extractEnvVarReferences(environmentVariables), [environmentVariables]);
    const { variables: actualEnvVars } = useEnvironmentVariables(machineId, envVarNames);

    const [name, setName] = React.useState(profile.name || '');

    const handleSave = () => {
        if (!name.trim()) return;
        onSave({
            ...profile,
            name: name.trim(),
            anthropicConfig: {},
            openaiConfig: {},
            azureOpenAIConfig: {},
            togetherAIConfig: {},
            environmentVariables,
            tmuxConfig: undefined,
            startupBashScript: undefined,
            defaultSessionType: undefined,
            defaultPermissionMode: undefined,
            defaultModelMode: undefined,
            compatibility: { claude: true, codex: true, cursor: true, gemini: true },
            updatedAt: Date.now(),
        });
    };

    return (
        <ScrollView
            style={[formStyles.scrollView, containerStyle]}
            contentContainerStyle={formStyles.scrollContent}
            keyboardShouldPersistTaps="handled"
        >
            <View style={formStyles.formContainer}>
                {/* Profile Name */}
                <Text style={formStyles.sectionTitle}>
                    {t('profiles.profileName')}
                </Text>
                <TextInput
                    style={formStyles.textInput}
                    placeholder={t('profiles.enterName')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={name}
                    onChangeText={setName}
                />

                {/* Built-in Profile Docs */}
                {profile.isBuiltIn && profileDocs && (
                    <View style={formStyles.docsBox}>
                        <View style={formStyles.docsHeader}>
                            <Ionicons name="information-circle" size={16} color={theme.colors.button.primary.tint} style={{ marginRight: 6 }} />
                            <Text style={formStyles.docsTitle}>Setup Instructions</Text>
                        </View>
                        <Text style={formStyles.docsText}>{profileDocs.description}</Text>
                        {profileDocs.setupGuideUrl && (
                            <Pressable
                                onPress={async () => {
                                    try {
                                        if (Platform.OS === 'web') {
                                            window.open(profileDocs.setupGuideUrl!, '_blank');
                                        } else {
                                            await Linking.openURL(profileDocs.setupGuideUrl!);
                                        }
                                    } catch { /* ignore */ }
                                }}
                                style={formStyles.docsButton}
                            >
                                <Ionicons name="book-outline" size={14} color={theme.colors.button.primary.tint} style={{ marginRight: 6 }} />
                                <Text style={formStyles.docsButtonText}>View Official Setup Guide</Text>
                                <Ionicons name="open-outline" size={12} color={theme.colors.button.primary.tint} />
                            </Pressable>
                        )}
                    </View>
                )}

                {/* Environment Variables */}
                <EnvironmentVariablesList
                    environmentVariables={environmentVariables}
                    machineId={machineId}
                    profileDocs={profileDocs}
                    onChange={setEnvironmentVariables}
                />

                {/* Actions */}
                <View style={formStyles.actions}>
                    <Pressable style={formStyles.cancelButton} onPress={onCancel}>
                        <Text style={formStyles.cancelText}>{t('common.cancel')}</Text>
                    </Pressable>
                    <Pressable style={formStyles.saveButton} onPress={handleSave}>
                        <Text style={formStyles.saveText}>
                            {profile.isBuiltIn ? t('common.saveAs') : t('common.save')}
                        </Text>
                    </Pressable>
                </View>
            </View>
        </ScrollView>
    );
}

const formStyles = StyleSheet.create((theme) => ({
    scrollView: {
        maxHeight: '100%',
    },
    scrollContent: {
        padding: theme.margins.md,
        flexGrow: 1,
    },
    formContainer: {
        borderRadius: theme.borderRadius.xl,
        padding: theme.margins.md,
        width: '100%',
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 6,
        ...Typography.default('semiBold'),
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: theme.borderRadius.lg,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: 10,
        fontSize: 15,
        color: theme.colors.text,
        marginBottom: theme.margins.md,
        borderWidth: 1,
        borderColor: theme.colors.textSecondary,
    },
    docsBox: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: theme.borderRadius.md,
        padding: theme.margins.sm,
        marginBottom: theme.margins.md,
        borderWidth: 1,
        borderColor: theme.colors.button.primary.background,
    },
    docsHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 6,
    },
    docsTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    docsText: {
        fontSize: 12,
        color: theme.colors.text,
        marginBottom: 8,
        lineHeight: 17,
        ...Typography.default(),
    },
    docsButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: theme.borderRadius.sm,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: 8,
    },
    docsButtonText: {
        fontSize: 12,
        color: theme.colors.button.primary.tint,
        fontWeight: '600',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    actions: {
        flexDirection: 'row',
        gap: 10,
    },
    cancelButton: {
        flex: 1,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: theme.borderRadius.sm,
        paddingVertical: 10,
        alignItems: 'center',
    },
    cancelText: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.button.secondary.tint,
        ...Typography.default('semiBold'),
    },
    saveButton: {
        flex: 1,
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: theme.borderRadius.sm,
        paddingVertical: 10,
        alignItems: 'center',
    },
    saveText: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
}));
