import React from 'react';
import { View, Text, Pressable, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettingMutable } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowDimensions } from 'react-native';
import { AIBackendProfile } from '@/sync/settings';
import { getBuiltInProfile, DEFAULT_PROFILES } from '@/sync/profileUtils';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { randomUUID } from 'expo-crypto';

interface ProfileDisplay {
    id: string;
    name: string;
    isBuiltIn: boolean;
}

interface ProfileManagerProps {
    onProfileSelect?: (profile: AIBackendProfile | null) => void;
    selectedProfileId?: string | null;
}

// Profile utilities now imported from @/sync/profileUtils

function ProfileManager({ onProfileSelect, selectedProfileId }: ProfileManagerProps) {
    const { theme } = useUnistyles();
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [lastUsedProfile, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const [editingProfile, setEditingProfile] = React.useState<AIBackendProfile | null>(null);
    const [showAddForm, setShowAddForm] = React.useState(false);
    const safeArea = useSafeAreaInsets();
    const screenWidth = useWindowDimensions().width;

    // Seed built-in profiles on first load
    const seedProfiles = React.useRef(false);
    if (!seedProfiles.current && profiles.length === 0) {
        seedProfiles.current = true;
        const seeds = DEFAULT_PROFILES
            .map(p => getBuiltInProfile(p.id))
            .filter((p): p is AIBackendProfile => p != null);
        for (const s of seeds) {
            // Check not already present (by id)
            if (!profiles.some(p => p.id === s.id)) {
                profiles.push(s);
            }
        }
        if (seeds.length > 0) {
            setProfiles([...profiles]);
        }
    }

    const handleAddProfile = () => {
        setEditingProfile({
            id: randomUUID(),
            name: '',
            anthropicConfig: {},
            environmentVariables: [],
            compatibility: { claude: true, codex: true, cursor: true, gemini: true },
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        });
        setShowAddForm(true);
    };

    const handleEditProfile = (profile: AIBackendProfile) => {
        setEditingProfile({ ...profile });
        setShowAddForm(true);
    };

    const handleDeleteProfile = async (profile: AIBackendProfile) => {
        if (profile.id === 'no-profile') {
            return;
        }
        const ok = await Modal.confirm(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            { confirmText: t('profiles.delete.confirm'), destructive: true }
        );
        if (!ok) return;

        const updatedProfiles = profiles.filter(p => p.id !== profile.id);
        setProfiles(updatedProfiles);
        if (lastUsedProfile === profile.id) {
            setLastUsedProfile(null);
        }
        if (selectedProfileId === profile.id && onProfileSelect) {
            onProfileSelect(null);
        }
    };

    const handleCloneProfile = (profile: AIBackendProfile) => {
        const clone: AIBackendProfile = {
            ...profile,
            id: randomUUID(),
            name: `${profile.name} (Copy)`,
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        setProfiles([...profiles, clone]);
    };

    const handleLongPressProfile = (profile: AIBackendProfile) => {
        Modal.alert(
            profile.name,
            undefined,
            [
                { text: t('profiles.copyProfile'), onPress: () => handleCloneProfile(profile) },
                { text: t('profiles.editProfile'), onPress: () => handleEditProfile(profile) },
                {
                    text: t('profiles.deleteProfile'), style: 'destructive',
                    onPress: () => handleDeleteProfile(profile),
                },
                { text: t('common.cancel'), style: 'cancel' },
            ]
        );
    };

    const handleSelectProfile = (profileId: string | null) => {
        const profile = profileId ? profiles.find(p => p.id === profileId) || null : null;
        if (onProfileSelect) {
            onProfileSelect(profile);
        }
        setLastUsedProfile(profileId);
    };

    const handleSaveProfile = (profile: AIBackendProfile) => {
        // Profile validation - ensure name is not empty
        if (!profile.name || profile.name.trim() === '') {
            return;
        }

        // Check for duplicate names (excluding current profile if editing)
        const isDuplicate = profiles.some(p =>
            p.id !== profile.id && p.name.trim() === profile.name.trim()
        );
        if (isDuplicate) return;

        if (profile.isBuiltIn) {
            // Replace built-in template with custom copy
            const newProfile: AIBackendProfile = {
                ...profile,
                id: randomUUID(),
                isBuiltIn: false,
                updatedAt: Date.now(),
            };
            setProfiles(profiles.map(p => p.id === profile.id ? newProfile : p));
        } else {
            const existingIndex = profiles.findIndex(p => p.id === profile.id);
            if (existingIndex >= 0) {
                const updated = [...profiles];
                updated[existingIndex] = profile;
                setProfiles(updated);
            } else {
                setProfiles([...profiles, profile]);
            }
        }

        setShowAddForm(false);
        setEditingProfile(null);
    };

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{
                    paddingHorizontal: screenWidth > 700 ? 16 : 8,
                    paddingBottom: safeArea.bottom + 100,
                }}
            >
                <View style={[{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }]}>
                    <Text style={{
                        fontSize: 24,
                        fontWeight: 'bold',
                        color: theme.colors.text,
                        marginVertical: 16,
                        ...Typography.default('semiBold')
                    }}>
                        {t('profiles.title')}
                    </Text>

                    {/* None option - no profile */}
                    <Pressable
                        style={{
                            backgroundColor: theme.colors.input.background,
                            borderRadius: 12,
                            padding: 16,
                            marginBottom: 12,
                            flexDirection: 'row',
                            alignItems: 'center',
                            borderWidth: selectedProfileId === null ? 2 : 0,
                            borderColor: theme.colors.text,
                        }}
                        onPress={() => handleSelectProfile(null)}
                    >
                        <View style={{
                            width: 24,
                            height: 24,
                            borderRadius: 12,
                            backgroundColor: theme.colors.button.secondary.tint,
                            justifyContent: 'center',
                            alignItems: 'center',
                            marginRight: 12,
                        }}>
                            <Ionicons name="remove" size={16} color="white" />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={{
                                fontSize: 16,
                                fontWeight: '600',
                                color: theme.colors.text,
                                ...Typography.default('semiBold')
                            }}>
                                {t('profiles.noProfile')}
                            </Text>
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                marginTop: 2,
                                ...Typography.default()
                            }}>
                                {t('profiles.noProfileDescription')}
                            </Text>
                        </View>
                        {selectedProfileId === null && (
                            <Ionicons name="checkmark-circle" size={20} color={theme.colors.text} />
                        )}
                    </Pressable>

                    {/* All profiles (seeded built-ins + user-created) */}
                    {profiles.map((profile) => (
                        <Pressable
                            key={profile.id}
                            style={{
                                backgroundColor: theme.colors.input.background,
                                borderRadius: 12,
                                padding: 16,
                                marginBottom: 12,
                                flexDirection: 'row',
                                alignItems: 'center',
                                borderWidth: selectedProfileId === profile.id ? 2 : 0,
                                borderColor: theme.colors.text,
                            }}
                            onPress={() => handleSelectProfile(profile.id)}
                            onLongPress={() => handleLongPressProfile(profile)}
                        >
                            <View style={{
                                width: 24,
                                height: 24,
                                borderRadius: 12,
                                backgroundColor: profile.isBuiltIn
                                    ? theme.colors.button.primary.background
                                    : theme.colors.button.secondary.tint,
                                justifyContent: 'center',
                                alignItems: 'center',
                                marginRight: 12,
                            }}>
                                <Ionicons
                                    name={profile.isBuiltIn ? 'star' : 'person'}
                                    size={16} color="white" />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={{
                                    fontSize: 16,
                                    fontWeight: '600',
                                    color: theme.colors.text,
                                    ...Typography.default('semiBold')
                                }}>
                                    {profile.name}
                                </Text>
                                <Text style={{
                                    fontSize: 14,
                                    color: theme.colors.textSecondary,
                                    marginTop: 2,
                                    ...Typography.default()
                                }}>
                                    {profile.anthropicConfig?.baseUrl
                                        || profile.openaiConfig?.baseUrl
                                        || profile.azureOpenAIConfig?.endpoint
                                        || profile.environmentVariables?.find(v => v.name.includes('URL') || v.name.includes('ENDPOINT'))?.value
                                        || t('profiles.defaultModel')}
                                </Text>
                            </View>
                            {selectedProfileId === profile.id && (
                                <Ionicons name="checkmark-circle" size={20} color={theme.colors.text} />
                            )}
                        </Pressable>
                    ))}

                    {/* Add profile button */}
                    <Pressable
                        style={{
                            backgroundColor: theme.colors.surface,
                            borderRadius: 12,
                            padding: 16,
                            marginBottom: 12,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                        onPress={handleAddProfile}
                    >
                        <Ionicons name="add-circle-outline" size={20} color={theme.colors.button.secondary.tint} />
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.colors.button.secondary.tint,
                            marginLeft: 8,
                            ...Typography.default('semiBold')
                        }}>
                            {t('profiles.addProfile')}
                        </Text>
                    </Pressable>
                </View>
            </ScrollView>

            {/* Profile Add/Edit Modal */}
            {showAddForm && editingProfile && (
                <KeyboardAvoidingView
                    style={profileManagerStyles.modalOverlay}
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                    keyboardVerticalOffset={safeArea.top}
                >
                    <View style={profileManagerStyles.modalBackdrop}>
                        <View style={[
                            profileManagerStyles.modalContent,
                            { paddingTop: safeArea.top + 16, paddingBottom: safeArea.bottom + 16 }
                        ]}>
                            <ProfileEditForm
                                profile={editingProfile}
                                onSave={handleSaveProfile}
                                onCancel={() => {
                                    setShowAddForm(false);
                                    setEditingProfile(null);
                                }}
                            />
                        </View>
                    </View>
                </KeyboardAvoidingView>
            )}
        </View>
    );
}

// ProfileEditForm now imported from @/components/ProfileEditForm

const profileManagerStyles = StyleSheet.create((theme, rt) => ({
    modalOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    modalBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: theme.margins.md,
    },
    modalContent: {
        width: '100%',
        maxWidth: Math.min(layout.maxWidth, 600),
        maxHeight: '90%',
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.xl,
        overflow: 'hidden',
    },
}));

export default ProfileManager;