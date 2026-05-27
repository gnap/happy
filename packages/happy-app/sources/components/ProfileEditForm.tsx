import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ViewStyle, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
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

    // Get documentation for built-in profiles
    const profileDocs = React.useMemo(() => {
        if (!profile.isBuiltIn) return null;
        return getBuiltInProfileDocumentation(profile.id);
    }, [profile.isBuiltIn, profile.id]);

    // Local state for environment variables (unified for all config)
    const [environmentVariables, setEnvironmentVariables] = React.useState<Array<{ name: string; value: string }>>(
        profile.environmentVariables || []
    );

    // Extract ${VAR} references from environmentVariables for querying daemon
    const envVarNames = React.useMemo(() => {
        return extractEnvVarReferences(environmentVariables);
    }, [environmentVariables]);

    // Query daemon environment using hook
    const { variables: actualEnvVars } = useEnvironmentVariables(machineId, envVarNames);

    const [name, setName] = React.useState(profile.name || '');

    const handleSave = () => {
        if (!name.trim()) {
            return;
        }

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
            style={[profileEditFormStyles.scrollView, containerStyle]}
            contentContainerStyle={profileEditFormStyles.scrollContent}
            keyboardShouldPersistTaps="handled"
        >
            <View style={profileEditFormStyles.formContainer}>
                    {/* Profile Name */}
                    <Text style={{
                        fontSize: 14,
                        fontWeight: '600',
                        color: theme.colors.text,
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                        {t('profiles.profileName')}
                    </Text>
                    <TextInput
                        style={{
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 10, // Matches new session panel input fields
                            padding: 12,
                            fontSize: 16,
                            color: theme.colors.text,
                            marginBottom: 16,
                            borderWidth: 1,
                            borderColor: theme.colors.textSecondary,
                        }}
                        placeholder={t('profiles.enterName')}
                        value={name}
                        onChangeText={setName}
                    />

                    {/* Built-in Profile Documentation - Setup Instructions */}
                    {profile.isBuiltIn && profileDocs && (
                        <View style={{
                            backgroundColor: theme.colors.surface,
                            borderRadius: 12,
                            padding: 16,
                            marginBottom: 20,
                            borderWidth: 1,
                            borderColor: theme.colors.button.primary.background,
                        }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                                <Ionicons name="information-circle" size={20} color={theme.colors.button.primary.tint} style={{ marginRight: 8 }} />
                                <Text style={{
                                    fontSize: 15,
                                    fontWeight: '600',
                                    color: theme.colors.text,
                                    ...Typography.default('semiBold')
                                }}>
                                    Setup Instructions
                                </Text>
                            </View>

                            <Text style={{
                                fontSize: 13,
                                color: theme.colors.text,
                                marginBottom: 12,
                                lineHeight: 18,
                                ...Typography.default()
                            }}>
                                {profileDocs.description}
                            </Text>

                            {profileDocs.setupGuideUrl && (
                                <Pressable
                                    onPress={async () => {
                                        try {
                                            const url = profileDocs.setupGuideUrl!;
                                            // On web/Tauri desktop, use window.open
                                            if (Platform.OS === 'web') {
                                                window.open(url, '_blank');
                                            } else {
                                                // On native (iOS/Android), use Linking API
                                                await Linking.openURL(url);
                                            }
                                        } catch (error) {
                                            console.error('Failed to open URL:', error);
                                        }
                                    }}
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        backgroundColor: theme.colors.button.primary.background,
                                        borderRadius: 8,
                                        padding: 12,
                                        marginBottom: 16,
                                    }}
                                >
                                    <Ionicons name="book-outline" size={16} color={theme.colors.button.primary.tint} style={{ marginRight: 8 }} />
                                    <Text style={{
                                        fontSize: 13,
                                        color: theme.colors.button.primary.tint,
                                        fontWeight: '600',
                                        flex: 1,
                                        ...Typography.default('semiBold')
                                    }}>
                                        View Official Setup Guide
                                    </Text>
                                    <Ionicons name="open-outline" size={14} color={theme.colors.button.primary.tint} />
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

                    {/* Action buttons */}
                    <View style={{ flexDirection: 'row', gap: 12 }}>
                        <Pressable
                            style={{
                                flex: 1,
                                backgroundColor: theme.colors.surface,
                                borderRadius: 8,
                                padding: 12,
                                alignItems: 'center',
                            }}
                            onPress={onCancel}
                        >
                            <Text style={{
                                fontSize: 16,
                                fontWeight: '600',
                                color: theme.colors.button.secondary.tint,
                                ...Typography.default('semiBold')
                            }}>
                                {t('common.cancel')}
                            </Text>
                        </Pressable>
                        {profile.isBuiltIn ? (
                            // For built-in profiles, show "Save As" button (creates custom copy)
                            <Pressable
                                style={{
                                    flex: 1,
                                    backgroundColor: theme.colors.button.primary.background,
                                    borderRadius: 8,
                                    padding: 12,
                                    alignItems: 'center',
                                }}
                                onPress={handleSave}
                            >
                                <Text style={{
                                    fontSize: 16,
                                    fontWeight: '600',
                                    color: theme.colors.button.primary.tint,
                                    ...Typography.default('semiBold')
                                }}>
                                    {t('common.saveAs')}
                                </Text>
                            </Pressable>
                        ) : (
                            // For custom profiles, show regular "Save" button
                            <Pressable
                                style={{
                                    flex: 1,
                                    backgroundColor: theme.colors.button.primary.background,
                                    borderRadius: 8,
                                    padding: 12,
                                    alignItems: 'center',
                                }}
                                onPress={handleSave}
                            >
                                <Text style={{
                                    fontSize: 16,
                                    fontWeight: '600',
                                    color: theme.colors.button.primary.tint,
                                    ...Typography.default('semiBold')
                                }}>
                                    {t('common.save')}
                                </Text>
                            </Pressable>
                        )}
                    </View>
                </View>
        </ScrollView>
    );
}

const profileEditFormStyles = StyleSheet.create((theme, rt) => ({
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: 20,
    },
    formContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16, // Matches new session panel main container
        padding: 20,
        width: '100%',
    },
}));
