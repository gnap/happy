import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ViewStyle, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AIBackendProfile } from '@/sync/settings';
import { getBuiltInProfileDocumentation } from '@/sync/profileUtils';
import { EnvironmentVariablesList } from '@/components/EnvironmentVariablesList';
import { Switch } from '@/components/Switch';
import { useAllMachines } from '@/sync/storage';
import { collectProxyRoutes } from '@/sync/proxyRoutes';

export interface ProfileEditFormProps {
    profile: AIBackendProfile;
    onSave: (profile: AIBackendProfile) => void;
    onCancel: () => void;
    containerStyle?: ViewStyle;
}

export function ProfileEditForm({
    profile,
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

    const [name, setName] = React.useState(profile.name || '');

    // Off unless the profile opted in. When on, all of this profile's traffic leaves through the
    // relay; with a SOCKS5 hop in the environment, the relay connects to that hop first.
    const [proxyViaRelay, setProxyViaRelay] = React.useState(profile.proxyViaRelay ?? false);

    // A route the relay defines and the machine serves on a fixed port. The name is the whole
    // profile-side contract; when set it takes precedence over the relay switch above.
    const [proxyRoute, setProxyRoute] = React.useState(profile.proxyRoute ?? '');
    // The names the known machines publish. The profile is account-level, so this is a union:
    // which of them a given session can actually use is decided on that machine, and refused
    // there rather than approximated here.
    const machines = useAllMachines();
    const knownRoutes = React.useMemo(
        () => collectProxyRoutes(machines, profile.proxyRoute),
        [machines, profile.proxyRoute],
    );
    // The list stays collapsed until asked for: it is a choice, not a menu to read every time.
    const [routePickerOpen, setRoutePickerOpen] = React.useState(false);

    const handleSave = () => {
        if (!name.trim()) return;
        const route = proxyRoute.trim();
        onSave({
            ...profile,
            name: name.trim(),
            environmentVariables,
            proxyViaRelay,
            proxyRoute: route ? route : undefined,
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
                    profileDocs={profileDocs}
                    onChange={setEnvironmentVariables}
                />

                {/* Named relay route */}
                <Text style={formStyles.sectionTitle}>
                    {t('profiles.proxyRoute')}
                </Text>
                <Text style={formStyles.switchDescription}>
                    {t('profiles.proxyRouteDescription')}
                </Text>
                {knownRoutes.length > 0 ? (
                    <View style={formStyles.routeFieldBlock}>
                        <Pressable
                            style={formStyles.routeField}
                            onPress={() => setRoutePickerOpen((open) => !open)}
                        >
                            <Text style={formStyles.routeFieldText}>
                                {proxyRoute.trim() || t('profiles.proxyRouteNone')}
                            </Text>
                            <Ionicons
                                name={routePickerOpen ? 'chevron-up' : 'chevron-down'}
                                size={18}
                                color={theme.colors.textSecondary}
                            />
                        </Pressable>
                        {routePickerOpen && (
                            <View style={formStyles.routeList}>
                                {[undefined, ...knownRoutes].map((route) => {
                                    const selected = route === undefined
                                        ? !proxyRoute.trim()
                                        : proxyRoute.trim() === route;
                                    return (
                                        <Pressable
                                            key={route ?? '__none__'}
                                            style={[formStyles.routeOption, selected && formStyles.routeOptionActive]}
                                            onPress={() => {
                                                setProxyRoute(route ?? '');
                                                setRoutePickerOpen(false);
                                            }}
                                        >
                                            <Text style={formStyles.routeOptionText}>
                                                {route ?? t('profiles.proxyRouteNone')}
                                            </Text>
                                            {selected && (
                                                <Ionicons name="checkmark" size={18} color={theme.colors.button.primary.tint} />
                                            )}
                                        </Pressable>
                                    );
                                })}
                            </View>
                        )}
                    </View>
                ) : (
                    // Nothing published yet — a newer relay route or a machine that has not
                    // reported in. Accept the name as typed; the session refuses it if unknown.
                    <TextInput
                        style={formStyles.textInput}
                        placeholder={t('profiles.proxyRoutePlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={proxyRoute}
                        onChangeText={setProxyRoute}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                )}

                {/* SOCKS5 egress route */}
                <View style={formStyles.switchRow}>
                    <View style={formStyles.switchText}>
                        <Text style={formStyles.sectionTitle}>
                            {t('profiles.proxyViaRelay')}
                        </Text>
                        <Text style={formStyles.switchDescription}>
                            {t('profiles.proxyViaRelayDescription')}
                        </Text>
                    </View>
                    <Switch
                        value={proxyViaRelay}
                        onValueChange={setProxyViaRelay}
                    />
                </View>

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
    routeFieldBlock: {
        marginBottom: theme.margins.md,
    },
    routeField: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: theme.colors.input.background,
        borderRadius: theme.borderRadius.lg,
        borderWidth: 1,
        borderColor: theme.colors.textSecondary,
        paddingHorizontal: theme.margins.sm,
        paddingVertical: 10,
    },
    routeFieldText: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default(),
    },
    routeList: {
        borderRadius: theme.borderRadius.lg,
        borderWidth: 1,
        borderColor: theme.colors.textSecondary,
        overflow: 'hidden',
        marginTop: 6,
    },
    routeOption: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.margins.sm,
        paddingVertical: 10,
    },
    routeOptionActive: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    routeOptionText: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default(),
    },
    switchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginBottom: theme.margins.md,
    },
    switchText: {
        flex: 1,
    },
    switchDescription: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        lineHeight: 17,
        ...Typography.default(),
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
