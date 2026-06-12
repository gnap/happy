import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Text, ActivityIndicator, TouchableWithoutFeedback, Image as RNImage, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { PermissionMode, ModelMode } from './PermissionModeSelector';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';
import { useActiveWord } from './autocomplete/useActiveWord';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { FloatingOverlay } from './FloatingOverlay';
import { Switch } from './Switch';
import { TextInputState, MultiTextInputHandle } from './MultiTextInput';
import { applySuggestion } from './autocomplete/applySuggestion';
import { GitStatusBadge, useHasMeaningfulGitStatus } from './GitStatusBadge';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/storage';
import { hackMode, hackModes } from '@/sync/modeHacks';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@/sync/storageTypes';
import { AIBackendProfile, getProfileEnvironmentVariables, validateProfileForAgent } from '@/sync/settings';
import { getBuiltInProfile, getProfilesForAgent } from '@/sync/profileUtils';
import { useRouter } from 'expo-router';

interface AgentInputProps {
    value: string;
    placeholder: string;
    onChangeText: (text: string) => void;
    sessionId?: string;
    onSend: () => void;
    sendIcon?: React.ReactNode;
    onMicPress?: () => void;
    isMicActive?: boolean;
    permissionMode?: PermissionMode | null;
    availableModes?: PermissionMode[];
    onPermissionModeChange?: (mode: PermissionMode) => void;
    modelMode?: ModelMode | null;
    availableModels?: ModelMode[];
    onModelModeChange?: (mode: ModelMode) => void;
    maxMode?: boolean;
    onMaxModeChange?: (enabled: boolean) => void;
    metadata?: Metadata | null;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
        cliStatus?: {
            claude: boolean | null;
            codex: boolean | null;
            cursor?: boolean | null;
            gemini?: boolean | null;
        };
    };
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<{ key: string, text: string, component: React.ElementType }[]>;
    usageData?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheCreation?: number;
        cacheRead?: number;
        contextSize: number;
        /** CLI /context counters — when present, display these instead of turn-end usage. */
        contextWindowTokens?: number;
        contextPct?: number;
        contextBreakdown?: {
            systemPrompt: number;
            systemTools: number;
            customAgents: number;
            skills: number;
            messages: number;
            freeSpace: number;
        };
    };
    alwaysShowContextSize?: boolean;
    maxContextSize?: number;
    onFileViewerPress?: () => void;
    agentType?: 'claude' | 'codex' | 'cursor' | 'cursor-acp' | 'gemini';
    onAgentClick?: () => void;
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
    isSendDisabled?: boolean;
    isSending?: boolean;
    minHeight?: number;
    profileId?: string | null;
    onProfileChange?: (profileId: string | null) => void;
}

const DEFAULT_MAX_CONTEXT_SIZE = 200000;

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignItems: 'center',
        paddingBottom: 8,
        paddingTop: 8,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
    },
    unifiedPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },

    // Overlay styles
    autocompleteOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    settingsOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    overlayBackdrop: {
        position: 'absolute',
        top: -1000,
        left: -1000,
        right: -1000,
        bottom: -1000,
        zIndex: 999,
    },
    overlaySection: {
        paddingVertical: 8,
    },
    overlaySectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
    overlayDivider: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginHorizontal: 16,
    },

    // Selection styles
    selectionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: 'transparent',
    },
    selectionItemPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    radioButton: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    radioButtonActive: {
        borderColor: theme.colors.radio.active,
    },
    radioButtonInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioButtonDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    selectionLabel: {
        fontSize: 14,
        ...Typography.default(),
    },
    selectionLabelActive: {
        color: theme.colors.radio.active,
    },
    selectionLabelInactive: {
        color: theme.colors.text,
    },

    // Status styles
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusText: {
        fontSize: 11,
        ...Typography.default(),
    },
    permissionModeContainer: {
        flexDirection: 'column',
        alignItems: 'flex-end',
    },
    permissionModeText: {
        fontSize: 11,
        ...Typography.default(),
    },
    contextWarningText: {
        fontSize: 11,
        marginLeft: 8,
        ...Typography.default(),
    },

    // Button styles
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        gap: 8,
        flex: 1,
        overflow: 'hidden',
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 8,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.button.secondary.tint,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonInnerPressed: {
        opacity: 0.7,
    },
    sendButtonIcon: {
        color: theme.colors.button.primary.tint,
    },
}));

const getContextWarning = (contextSize: number, maxContextSize: number, alwaysShow: boolean = false, theme: Theme, contextPct?: number) => {
    const percentageRemaining = contextPct
        ? Math.max(0, Math.min(100, 100 - contextPct))
        : Math.max(0, Math.min(100, 100 - (contextSize / maxContextSize) * 100));

    if (percentageRemaining <= 5) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warningCritical };
    } else if (percentageRemaining <= 10) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    } else if (alwaysShow) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    }
    return null;
};

const formatTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

const BREAKDOWN_LABELS: Record<string, string> = {
    systemPrompt: 'System Prompt',
    systemTools: 'System Tools',
    customAgents: 'Custom Agents',
    skills: 'Skills',
    messages: 'Messages',
    freeSpace: 'Free Space',
};

const ContextBreakdown = React.memo(({ breakdown }: { breakdown: NonNullable<AgentInputProps['usageData']>['contextBreakdown'] }) => {
    const { theme } = useUnistyles();
    if (!breakdown) return null;
    const items = Object.entries(breakdown).filter(([, v]) => v > 0 || true);
    return (
        <View style={{ padding: 12, gap: 6 }}>
            {(Object.keys(BREAKDOWN_LABELS) as (keyof typeof BREAKDOWN_LABELS)[]).map((key) => {
                const value = (breakdown as Record<string, number>)[key];
                if (value === undefined) return null;
                return (
                    <View key={key} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {BREAKDOWN_LABELS[key]}
                        </Text>
                        <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.mono() }}>
                            {formatTokens(value)}
                        </Text>
                    </View>
                );
            })}
        </View>
    );
});

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const screenWidth = useWindowDimensions().width;

    const hasText = props.value.trim().length > 0;

    // Use metadata.flavor for existing sessions, agentType prop for new sessions
    const isCodex = props.metadata?.flavor === 'codex' || props.agentType === 'codex';
    const isCursor = props.metadata?.flavor === 'cursor' || props.metadata?.flavor === 'acp-cursor' || props.agentType === 'cursor' || props.agentType === 'cursor-acp';
    const isGemini = props.metadata?.flavor === 'gemini' || props.agentType === 'gemini';
    const displayPermissionMode = React.useMemo(() => (
        props.permissionMode ? hackMode(props.permissionMode) : null
    ), [props.permissionMode]);
    const permissionModeKey = displayPermissionMode?.key ?? 'default';
    const availableModes = React.useMemo(() => (
        hackModes(props.availableModes ?? [])
    ), [props.availableModes]);
    const availableModels = props.availableModels ?? [];
    const isSandboxEnabled = React.useMemo(() => {
        const sandbox = props.metadata?.sandbox as unknown;
        if (!sandbox) {
            return false;
        }
        if (typeof sandbox === 'object' && sandbox !== null && 'enabled' in sandbox) {
            return Boolean((sandbox as { enabled?: unknown }).enabled);
        }
        return true;
    }, [props.metadata?.sandbox]);
    const isSandboxedYoloMode = isSandboxEnabled && (
        permissionModeKey === 'bypassPermissions' || permissionModeKey === 'yolo'
    );

    const withSandboxSuffix = React.useCallback((label: string, modeKey?: string) => {
        if (!isSandboxEnabled) {
            return label;
        }
        if (modeKey === 'bypassPermissions' || modeKey === 'yolo') {
            return `${label} (sandboxed)`;
        }
        return label;
    }, [isSandboxEnabled]);

    const router = useRouter();
    const customProfiles = useSetting('profiles');
    const availableProfiles = React.useMemo(
        () => getProfilesForAgent(customProfiles, props.agentType),
        [customProfiles, props.agentType],
    );
    const currentProfile = React.useMemo(() => {
        if (!props.profileId) return null;
        const customProfile = customProfiles.find(p => p.id === props.profileId);
        if (customProfile) return customProfile;
        return getBuiltInProfile(props.profileId);
    }, [customProfiles, props.profileId]);
    const showProfileControls = !!props.onProfileChange && availableProfiles.length > 0;
    const hasActiveProfile = !!props.profileId && !!currentProfile;
    const [showProfileOverlay, setShowProfileOverlay] = React.useState(false);

    // Calculate context warning - use CLI /context pct when available
    const contextPct = props.usageData?.contextPct;
    const effectiveMaxContext = props.usageData?.contextWindowTokens ?? props.maxContextSize ?? DEFAULT_MAX_CONTEXT_SIZE;
    const contextWarning = props.usageData?.contextSize
        ? getContextWarning(props.usageData.contextSize, effectiveMaxContext, props.alwaysShowContextSize ?? false, theme, contextPct)
        : null;

    // Progress bar fill level: use contextPct from CLI, or calculate
    const contextFillPct = contextPct ?? (props.usageData?.contextSize && effectiveMaxContext > 0
        ? Math.min(100, (props.usageData.contextSize / effectiveMaxContext) * 100)
        : 0);
    const showContextBar = contextFillPct > 0 && (props.alwaysShowContextSize || contextFillPct >= 70);
    const contextBarColor = contextFillPct >= 95 ? theme.colors.warningCritical
        : contextFillPct >= 80 ? theme.colors.warning
        : theme.colors.textSecondary;
    const [showContextBreakdown, setShowContextBreakdown] = React.useState(false);

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    // Autocomplete state - track text and selection together
    const [inputState, setInputState] = React.useState<TextInputState>({
        text: props.value,
        selection: { start: 0, end: 0 }
    });

    // Handle combined text and selection state changes
    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        // console.log('📝 Input state changed:', JSON.stringify(newState));
        setInputState(newState);
    }, []);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Debug logging
    // React.useEffect(() => {
    //     console.log('🔍 Autocomplete Debug:', JSON.stringify({
    //         value: props.value,
    //         inputState,
    //         activeWord,
    //         suggestionsCount: suggestions.length,
    //         selected,
    //         prefixes: props.autocompletePrefixes
    //     }, null, 2));
    // }, [props.value, inputState, activeWord, suggestions.length, selected]);

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];

        // Apply the suggestion
        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            props.autocompletePrefixes,
            true // add space after
        );

        // Use imperative API to set text and selection
        inputRef.current.setTextAndSelection(result.text, {
            start: result.cursorPosition,
            end: result.cursorPosition
        });

        // console.log('Selected suggestion:', suggestion.text);

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // Settings modal state
    const [showSettings, setShowSettings] = React.useState(false);

    // Handle settings button press
    const handleSettingsPress = React.useCallback(() => {
        hapticsLight();
        setShowSettings(prev => !prev);
    }, []);

    const openProfilePicker = React.useCallback(() => {
        hapticsLight();
        setShowProfileOverlay(true);
    }, []);

    // Handle settings selection
    const handleSettingsSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        // Don't close the settings overlay - let users see the change and potentially switch again
    }, [props.onPermissionModeChange]);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;

        hapticsError();
        setIsAborting(true);
        const startTime = Date.now();

        try {
            await props.onAbort?.();

            // Ensure minimum 300ms loading time
            const elapsed = Date.now() - startTime;
            if (elapsed < 300) {
                await new Promise(resolve => setTimeout(resolve, 300 - elapsed));
            }
        } catch (error) {
            // Shake on error
            shakerRef.current?.shake();
            console.error('Abort RPC call failed:', error);
        } finally {
            setIsAborting(false);
        }
    }, [props.onAbort]);

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (event.key === 'ArrowUp') {
                moveUp();
                return true;
            } else if (event.key === 'ArrowDown') {
                moveDown();
                return true;
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                // Both Enter and Tab select the current suggestion
                // If none selected (selected === -1), select the first one
                const indexToSelect = selected >= 0 ? selected : 0;
                handleSuggestionSelect(indexToSelect);
                return true;
            } else if (event.key === 'Escape') {
                // Clear suggestions by collapsing selection (triggers activeWord to clear)
                if (inputRef.current) {
                    const cursorPos = inputState.selection.start;
                    inputRef.current.setTextAndSelection(inputState.text, {
                        start: cursorPos,
                        end: cursorPos
                    });
                }
                return true;
            }
        }

        // Handle Escape for abort when no suggestions are visible
        if (event.key === 'Escape' && props.showAbortButton && props.onAbort && !isAborting) {
            handleAbortPress();
            return true;
        }

        // Original key handling
        if (Platform.OS === 'web') {
            if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey) {
                if (props.value.trim()) {
                    props.onSend();
                    return true; // Key was handled
                }
            }
            // Handle Shift+Tab for permission mode switching
            if (event.key === 'Tab' && event.shiftKey && props.onPermissionModeChange && availableModes.length > 0) {
                const currentIndex = availableModes.findIndex((mode) => mode.key === permissionModeKey);
                const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + 1) % availableModes.length;
                props.onPermissionModeChange(availableModes[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }

        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, agentInputEnterToSend, props.value, props.onSend, props.onPermissionModeChange, availableModes, permissionModeKey]);




    return (
        <View style={[
            styles.container,
            { paddingHorizontal: screenWidth > 700 ? 16 : 8 }
        ]}>
            <View style={[
                styles.innerContainer,
                { maxWidth: layout.maxWidth }
            ]}>
                {/* Autocomplete suggestions overlay */}
                {suggestions.length > 0 && (
                    <View style={[
                        styles.autocompleteOverlay,
                        { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                    ]}>
                        <AgentInputAutocomplete
                            suggestions={suggestions.map(s => {
                                const Component = s.component;
                                return <Component key={s.key} />;
                            })}
                            selectedIndex={selected}
                            onSelect={handleSuggestionSelect}
                            itemHeight={48}
                        />
                    </View>
                )}

                {/* Settings overlay */}
                {showSettings && (
                    <>
                        <TouchableWithoutFeedback onPress={() => setShowSettings(false)}>
                            <View style={styles.overlayBackdrop} />
                        </TouchableWithoutFeedback>
                        <View style={[
                            styles.settingsOverlay,
                            { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                        ]}>
                            <FloatingOverlay maxHeight={400} keyboardShouldPersistTaps="always">
                                {/* Permission Mode Section */}
                                <View style={styles.overlaySection}>
                                    <Text style={styles.overlaySectionTitle}>
                                        {isCodex ? t('agentInput.codexPermissionMode.title') : isCursor ? t('agentInput.cursorPermissionMode.title') : isGemini ? t('agentInput.geminiPermissionMode.title') : t('agentInput.permissionMode.title')}
                                    </Text>
                                    {availableModes.map((mode) => {
                                        const isSelected = permissionModeKey === mode.key;

                                        return (
                                            <Pressable
                                                key={mode.key}
                                                onPress={() => handleSettingsSelect(mode)}
                                                style={({ pressed }) => ({
                                                    flexDirection: 'row',
                                                    alignItems: 'center',
                                                    paddingHorizontal: 16,
                                                    paddingVertical: 8,
                                                    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent'
                                                })}
                                            >
                                                <View style={{
                                                    width: 16,
                                                    height: 16,
                                                    borderRadius: 8,
                                                    borderWidth: 2,
                                                    borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    marginRight: 12
                                                }}>
                                                    {isSelected && (
                                                        <View style={{
                                                            width: 6,
                                                            height: 6,
                                                            borderRadius: 3,
                                                            backgroundColor: theme.colors.radio.dot
                                                        }} />
                                                    )}
                                                </View>
                                                <View style={{ flex: 1 }}>
                                                    <Text style={{
                                                        fontSize: 14,
                                                        color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                        ...Typography.default()
                                                    }}>
                                                        {withSandboxSuffix(mode.name, mode.key)}
                                                    </Text>
                                                    {!!mode.description && (
                                                        <Text style={{
                                                            fontSize: 11,
                                                            color: theme.colors.textSecondary,
                                                            ...Typography.default()
                                                        }}>
                                                            {mode.description}
                                                        </Text>
                                                    )}
                                                </View>
                                            </Pressable>
                                        );
                                    })}
                                </View>

                                {/* Divider */}
                                <View style={{
                                    height: 1,
                                    backgroundColor: theme.colors.divider,
                                    marginHorizontal: 16
                                }} />

                                {/* Model Section */}
                                <View style={{ paddingVertical: 8 }}>
                                    <View style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        paddingHorizontal: 16,
                                        paddingBottom: 4,
                                    }}>
                                        <Text style={{
                                            fontSize: 12,
                                            fontWeight: '600',
                                            color: theme.colors.textSecondary,
                                            ...Typography.default('semiBold')
                                        }}>
                                            {t('agentInput.model.title')}
                                        </Text>
                                        {isCursor && props.onMaxModeChange && (
                                            <View style={{
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                gap: 8,
                                            }}>
                                                <Text style={{
                                                    fontSize: 12,
                                                    color: theme.colors.textSecondary,
                                                    ...Typography.default()
                                                }}>
                                                    {t('agentInput.model.maxMode')}
                                                </Text>
                                                <Switch
                                                    value={props.maxMode ?? false}
                                                    onValueChange={(value) => {
                                                        hapticsLight();
                                                        props.onMaxModeChange?.(value);
                                                    }}
                                                />
                                            </View>
                                        )}
                                    </View>
                                    {availableModels.length > 0 ? (
                                        availableModels.map((model) => {
                                            const isSelected = props.modelMode?.key === model.key;

                                            return (
                                                <Pressable
                                                    key={model.key}
                                                    onPress={() => {
                                                        hapticsLight();
                                                        props.onModelModeChange?.(model);
                                                    }}
                                                    style={({ pressed }) => ({
                                                        flexDirection: 'row',
                                                        alignItems: 'center',
                                                        paddingHorizontal: 16,
                                                        paddingVertical: 8,
                                                        backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent'
                                                    })}
                                                >
                                                    <View style={{
                                                        width: 16,
                                                        height: 16,
                                                        borderRadius: 8,
                                                        borderWidth: 2,
                                                        borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        marginRight: 12
                                                    }}>
                                                        {isSelected && (
                                                            <View style={{
                                                                width: 6,
                                                                height: 6,
                                                                borderRadius: 3,
                                                                backgroundColor: theme.colors.radio.dot
                                                            }} />
                                                        )}
                                                    </View>
                                                    <View>
                                                        <Text style={{
                                                            fontSize: 14,
                                                            color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                            ...Typography.default()
                                                        }}>
                                                            {model.name}
                                                        </Text>
                                                        {!!model.description && (
                                                            <Text style={{
                                                                fontSize: 11,
                                                                color: theme.colors.textSecondary,
                                                                ...Typography.default()
                                                            }}>
                                                                {model.description}
                                                            </Text>
                                                        )}
                                                    </View>
                                                </Pressable>
                                            );
                                        })
                                    ) : (
                                        <Text style={{
                                            fontSize: 13,
                                            color: theme.colors.textSecondary,
                                            paddingHorizontal: 16,
                                            paddingVertical: 8,
                                            ...Typography.default()
                                        }}>
                                            {t('agentInput.model.configureInCli')}
                                        </Text>
                                    )}
                                </View>

                            </FloatingOverlay>
                        </View>
                    </>
                )}

                {/* Connection status, context warning, and permission mode */}
                {(props.connectionStatus || contextWarning || props.usageData?.contextSize || displayPermissionMode || props.modelMode) && (
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 16,
                        paddingBottom: 4,
                        minHeight: 20, // Fixed minimum height to prevent jumping
                    }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 11 }}>
                            {props.connectionStatus && (
                                <>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                        <StatusDot
                                            color={props.connectionStatus.dotColor}
                                            isPulsing={props.connectionStatus.isPulsing}
                                            size={6}
                                        />
                                        <Text style={{
                                            fontSize: 11,
                                            color: props.connectionStatus.color,
                                            ...Typography.default()
                                        }}>
                                            {props.connectionStatus.text}
                                        </Text>
                                    </View>
                                    {/* CLI Status - only shown when provided (wizard only) */}
                                    {props.connectionStatus.cliStatus && (
                                        <>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: props.connectionStatus.cliStatus.claude
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    {props.connectionStatus.cliStatus.claude ? '✓' : '✗'}
                                                </Text>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: props.connectionStatus.cliStatus.claude
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    claude
                                                </Text>
                                            </View>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: props.connectionStatus.cliStatus.codex
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    {props.connectionStatus.cliStatus.codex ? '✓' : '✗'}
                                                </Text>
                                                <Text style={{
                                                    fontSize: 11,
                                                    color: props.connectionStatus.cliStatus.codex
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    codex
                                                </Text>
                                            </View>
                                            {props.connectionStatus.cliStatus.cursor !== undefined && (
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: props.connectionStatus.cliStatus.cursor
                                                            ? theme.colors.success
                                                            : theme.colors.textDestructive,
                                                        ...Typography.default()
                                                    }}>
                                                        {props.connectionStatus.cliStatus.cursor ? '✓' : '✗'}
                                                    </Text>
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: props.connectionStatus.cliStatus.cursor
                                                            ? theme.colors.success
                                                            : theme.colors.textDestructive,
                                                        ...Typography.default()
                                                    }}>
                                                        cursor
                                                    </Text>
                                                </View>
                                            )}
                                            {props.connectionStatus.cliStatus.gemini !== undefined && (
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: props.connectionStatus.cliStatus.gemini
                                                            ? theme.colors.success
                                                            : theme.colors.textDestructive,
                                                        ...Typography.default()
                                                    }}>
                                                        {props.connectionStatus.cliStatus.gemini ? '✓' : '✗'}
                                                    </Text>
                                                    <Text style={{
                                                        fontSize: 11,
                                                        color: props.connectionStatus.cliStatus.gemini
                                                            ? theme.colors.success
                                                            : theme.colors.textDestructive,
                                                        ...Typography.default()
                                                    }}>
                                                        gemini
                                                    </Text>
                                                </View>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                            {(contextWarning || props.usageData?.contextSize) && (
                                <>
                                    <Pressable
                                        onPress={() => {
                                            if (props.usageData?.contextBreakdown) {
                                                setShowContextBreakdown(!showContextBreakdown);
                                            }
                                        }}
                                        style={({ pressed }) => ({
                                            opacity: props.usageData?.contextBreakdown && pressed ? 0.6 : 1,
                                        })}
                                    >
                                        <Text style={{
                                            fontSize: 11,
                                            color: contextWarning?.color ?? theme.colors.textSecondary,
                                            marginLeft: props.connectionStatus ? 8 : 0,
                                            ...Typography.default()
                                        }}>
                                            {!props.usageData?.contextSize && props.connectionStatus ? '• ' : ''}
                                            {props.usageData?.contextSize
                                                ? (props.usageData.contextSize >= 1_000_000
                                                    ? `${(props.usageData.contextSize / 1_000_000).toFixed(1)}M`
                                                    : props.usageData.contextSize >= 1000
                                                    ? `${Math.round(props.usageData.contextSize / 1000)}K`
                                                    : String(props.usageData.contextSize))
                                                : ''}
                                            {props.usageData?.contextSize && props.usageData?.contextWindowTokens
                                                ? ` / ${props.usageData.contextWindowTokens >= 1_000_000
                                                    ? `${(props.usageData.contextWindowTokens / 1_000_000).toFixed(1)}M`
                                                    : `${Math.round(props.usageData.contextWindowTokens / 1000)}K`}`
                                                : ''}
                                            {props.usageData?.contextSize && contextPct ? ` (${contextPct}%)` : ''}
                                        </Text>
                                    </Pressable>
                                    {showContextBreakdown && props.usageData?.contextBreakdown && (
                                        <View style={{
                                            position: 'absolute',
                                            bottom: '100%',
                                            left: 0,
                                            right: 0,
                                            zIndex: 1001,
                                            paddingHorizontal: 16,
                                            paddingBottom: 4,
                                        }}>
                                            <FloatingOverlay maxHeight={260}>
                                                <ContextBreakdown breakdown={props.usageData.contextBreakdown} />
                                            </FloatingOverlay>
                                        </View>
                                    )}
                                    {showContextBreakdown && props.usageData?.contextBreakdown && (
                                        <TouchableWithoutFeedback onPress={() => setShowContextBreakdown(false)}>
                                            <View style={{
                                                position: 'absolute',
                                                top: -1000,
                                                left: -1000,
                                                right: -1000,
                                                bottom: '100%',
                                                zIndex: 1000,
                                            }} />
                                        </TouchableWithoutFeedback>
                                    )}
                                </>
                            )}
                        </View>
                        <View style={{
                            flexDirection: 'column',
                            alignItems: 'flex-end',
                            minWidth: 150, // Fixed minimum width to prevent layout shift
                        }}>
                            {displayPermissionMode && (
                                <Text style={{
                                    fontSize: 11,
                                    color: isSandboxedYoloMode ? '#4169E1' :
                                        permissionModeKey === 'acceptEdits' ? theme.colors.permission.acceptEdits :
                                            permissionModeKey === 'bypassPermissions' ? theme.colors.permission.bypass :
                                                permissionModeKey === 'plan' ? theme.colors.permission.plan :
                                                    permissionModeKey === 'ask' ? theme.colors.permission.ask :
                                                        permissionModeKey === 'read-only' ? theme.colors.permission.readOnly :
                                                            permissionModeKey === 'safe-yolo' ? theme.colors.permission.safeYolo :
                                                                permissionModeKey === 'yolo' ? theme.colors.permission.yolo :
                                                                    permissionModeKey === 'force' ? theme.colors.permission.force :
                                                                        theme.colors.textSecondary, // Use secondary text color for default
                                    ...Typography.default()
                                }}>
                                    {withSandboxSuffix(displayPermissionMode.name, permissionModeKey)}
                                </Text>
                            )}
                            {props.modelMode && (
                                <Text style={{
                                    fontSize: 11,
                                    color: theme.colors.textSecondary,
                                    ...Typography.default()
                                }}>
                                    {props.modelMode.name}
                                </Text>
                            )}
                        </View>
                    </View>
                )}

                {/* Context usage progress bar */}
                {showContextBar ? (
                    <View style={{
                        height: 2,
                        backgroundColor: theme.colors.surfacePressed,
                        marginHorizontal: 16,
                        marginBottom: 2,
                    }}>
                        <View style={{
                            height: 2,
                            width: `${Math.min(100, contextFillPct)}%`,
                            backgroundColor: contextBarColor,
                        }} />
                    </View>
                ) : null}

                {/* Env profile picker (opened from bottom chip only) */}
                {showProfileOverlay && showProfileControls && (
                    <>
                        <TouchableWithoutFeedback onPress={() => setShowProfileOverlay(false)}>
                            <View style={styles.overlayBackdrop} />
                        </TouchableWithoutFeedback>
                        <View style={[
                            styles.settingsOverlay,
                            { paddingHorizontal: screenWidth > 700 ? 0 : 8 },
                        ]}>
                            <FloatingOverlay maxHeight={360} keyboardShouldPersistTaps="always">
                                <View style={styles.overlaySection}>
                                    <Text style={styles.overlaySectionTitle}>
                                        {t('agentInput.profile.title')}
                                    </Text>
                                    <Pressable
                                        onPress={() => {
                                            hapticsLight();
                                            props.onProfileChange?.(null);
                                            setShowProfileOverlay(false);
                                        }}
                                        style={({ pressed }) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            paddingHorizontal: 16,
                                            paddingVertical: 8,
                                            backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                        })}
                                    >
                                        <View style={{
                                            width: 16,
                                            height: 16,
                                            borderRadius: 8,
                                            borderWidth: 2,
                                            borderColor: !props.profileId ? theme.colors.radio.active : theme.colors.radio.inactive,
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            marginRight: 12,
                                        }}>
                                            {!props.profileId && (
                                                <View style={{
                                                    width: 6,
                                                    height: 6,
                                                    borderRadius: 3,
                                                    backgroundColor: theme.colors.radio.dot,
                                                }} />
                                            )}
                                        </View>
                                        <Text style={{
                                            fontSize: 14,
                                            color: !props.profileId ? theme.colors.radio.active : theme.colors.text,
                                            ...Typography.default(),
                                        }}>
                                            {t('agentInput.profile.none')}
                                        </Text>
                                    </Pressable>
                                    {availableProfiles.map((profile) => {
                                        const isSelected = props.profileId === profile.id;
                                        return (
                                            <Pressable
                                                key={profile.id}
                                                onPress={() => {
                                                    hapticsLight();
                                                    props.onProfileChange?.(profile.id);
                                                    setShowProfileOverlay(false);
                                                }}
                                                style={({ pressed }) => ({
                                                    flexDirection: 'row',
                                                    alignItems: 'center',
                                                    paddingHorizontal: 16,
                                                    paddingVertical: 8,
                                                    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                                })}
                                            >
                                                <View style={{
                                                    width: 16,
                                                    height: 16,
                                                    borderRadius: 8,
                                                    borderWidth: 2,
                                                    borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    marginRight: 12,
                                                }}>
                                                    {isSelected && (
                                                        <View style={{
                                                            width: 6,
                                                            height: 6,
                                                            borderRadius: 3,
                                                            backgroundColor: theme.colors.radio.dot,
                                                        }} />
                                                    )}
                                                </View>
                                                <Text style={{
                                                    fontSize: 14,
                                                    color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                    ...Typography.default(),
                                                }}>
                                                    {profile.name}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                    <Pressable
                                        onPress={() => {
                                            hapticsLight();
                                            setShowProfileOverlay(false);
                                            router.push('/settings/profiles');
                                        }}
                                        style={({ pressed }) => ({
                                            paddingHorizontal: 16,
                                            paddingVertical: 10,
                                            opacity: pressed ? 0.7 : 1,
                                        })}
                                    >
                                        <Text style={{
                                            fontSize: 13,
                                            color: theme.colors.textLink,
                                            ...Typography.default(),
                                        }}>
                                            {t('agentInput.profile.manage')}
                                        </Text>
                                    </Pressable>
                                </View>
                            </FloatingOverlay>
                        </View>
                    </>
                )}

                {/* Box 1: Context Information (Machine + Path) - Only show if either exists */}
                {(props.machineName !== undefined || props.currentPath) && (
                    <View style={{
                        backgroundColor: theme.colors.surfacePressed,
                        borderRadius: 12,
                        padding: 8,
                        marginBottom: 8,
                        gap: 4,
                    }}>
                        {/* Machine chip */}
                        {props.machineName !== undefined && props.onMachineClick && (
                            <Pressable
                                onPress={() => {
                                    hapticsLight();
                                    props.onMachineClick?.();
                                }}
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                    paddingHorizontal: 10,
                                    paddingVertical: 6,
                                    height: 32,
                                    opacity: p.pressed ? 0.7 : 1,
                                    gap: 6,
                                })}
                            >
                                <Ionicons
                                    name="desktop-outline"
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Text style={{
                                    fontSize: 13,
                                    color: theme.colors.text,
                                    fontWeight: '600',
                                    ...Typography.default('semiBold'),
                                }}>
                                    {props.machineName === null ? t('agentInput.noMachinesAvailable') : props.machineName}
                                </Text>
                            </Pressable>
                        )}

                        {/* Path chip */}
                        {props.currentPath && props.onPathClick && (
                            <Pressable
                                onPress={() => {
                                    hapticsLight();
                                    props.onPathClick?.();
                                }}
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                    paddingHorizontal: 10,
                                    paddingVertical: 6,
                                    height: 32,
                                    opacity: p.pressed ? 0.7 : 1,
                                    gap: 6,
                                })}
                            >
                                <Ionicons
                                    name="folder-outline"
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Text style={{
                                    fontSize: 13,
                                    color: theme.colors.text,
                                    fontWeight: '600',
                                    ...Typography.default('semiBold'),
                                }}>
                                    {props.currentPath}
                                </Text>
                            </Pressable>
                        )}
                    </View>
                )}

                {/* Box 2: Action Area (Input + Send) */}
                <View style={styles.unifiedPanel}>
                    {/* Input field */}
                    <View style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}>
                        <MultiTextInput
                            ref={inputRef}
                            value={props.value}
                            paddingTop={Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={Platform.OS === 'web' ? 10 : 8}
                            onChangeText={props.onChangeText}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={120}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={styles.actionButtonsContainer}>
                        <View style={{ flexDirection: 'column', flex: 1, gap: 2 }}>
                            {/* Row 1: Settings, Profile (FIRST), Agent, Abort, Git Status */}
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                <View style={styles.actionButtonsLeft}>

                                {/* Settings button */}
                                {props.onPermissionModeChange && (
                                    <Pressable
                                        onPress={handleSettingsPress}
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
                                        <Octicons
                                            name={'gear'}
                                            size={16}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                    </Pressable>
                                )}

                                {showProfileControls && (
                                    <Pressable
                                        onPress={openProfilePicker}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 10,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                            gap: 6,
                                        })}
                                    >
                                        <Ionicons
                                            name="person-outline"
                                            size={14}
                                            color={hasActiveProfile
                                                ? theme.colors.button.secondary.tint
                                                : theme.colors.textSecondary}
                                        />
                                        {hasActiveProfile && (
                                            <Text style={{
                                                fontSize: 13,
                                                color: theme.colors.button.secondary.tint,
                                                fontWeight: '600',
                                                ...Typography.default('semiBold'),
                                            }}>
                                                {currentProfile!.name}
                                            </Text>
                                        )}
                                    </Pressable>
                                )}

                                {/* Agent selector button */}
                                {props.agentType && props.onAgentClick && (
                                    <Pressable
                                        onPress={() => {
                                            hapticsLight();
                                            props.onAgentClick?.();
                                        }}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 10,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                            gap: 6,
                                        })}
                                    >
                                        <Octicons
                                            name="cpu"
                                            size={14}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                        <Text style={{
                                            fontSize: 13,
                                            color: theme.colors.button.secondary.tint,
                                            fontWeight: '600',
                                            ...Typography.default('semiBold'),
                                        }}>
                                            {props.agentType === 'claude' ? t('agentInput.agent.claude') : props.agentType === 'codex' ? t('agentInput.agent.codex') : props.agentType === 'cursor-acp' ? t('agentInput.agent.cursorAcp') : props.agentType === 'cursor' ? t('agentInput.agent.cursor') : t('agentInput.agent.gemini')}
                                        </Text>
                                    </Pressable>
                                )}

                                {/* Abort button */}
                                {props.onAbort && (
                                    <Shaker ref={shakerRef}>
                                        <Pressable
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
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            onPress={handleAbortPress}
                                            disabled={isAborting}
                                        >
                                            {isAborting ? (
                                                <ActivityIndicator
                                                    size="small"
                                                    color={theme.colors.button.secondary.tint}
                                                />
                                            ) : (
                                                <Octicons
                                                    name={"stop"}
                                                    size={16}
                                                    color={theme.colors.button.secondary.tint}
                                                />
                                            )}
                                        </Pressable>
                                    </Shaker>
                                )}

                                {/* Git Status Badge */}
                                <GitStatusButton sessionId={props.sessionId} onPress={props.onFileViewerPress} />
                                </View>

                                {/* Send/Voice button - aligned with first row */}
                                <View
                                    style={[
                                        styles.sendButton,
                                        (hasText || props.isSending || (props.onMicPress && !props.isMicActive))
                                            ? styles.sendButtonActive
                                            : styles.sendButtonInactive
                                    ]}
                                >
                                    <Pressable
                                        style={(p) => ({
                                            width: '100%',
                                            height: '100%',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        onPress={() => {
                                            hapticsLight();
                                            if (hasText) {
                                                props.onSend();
                                            } else {
                                                props.onMicPress?.();
                                            }
                                        }}
                                        disabled={props.isSendDisabled || props.isSending || (!hasText && !props.onMicPress)}
                                    >
                                        {props.isSending ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={theme.colors.button.primary.tint}
                                            />
                                        ) : hasText ? (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        ) : props.onMicPress && !props.isMicActive ? (
                                            <Image
                                                source={require('@/assets/images/icon-voice-white.png')}
                                                style={{
                                                    width: 24,
                                                    height: 24,
                                                }}
                                                tintColor={theme.colors.button.primary.tint}
                                            />
                                        ) : (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        )}
                                    </Pressable>
                                </View>
                            </View>
                        </View>
                    </View>
                </View>
            </View>
        </View>
    );
}));

// Git Status Button Component
function GitStatusButton({ sessionId, onPress }: { sessionId?: string, onPress?: () => void }) {
    const hasMeaningfulGitStatus = useHasMeaningfulGitStatus(sessionId || '');
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (!sessionId || !onPress) {
        return null;
    }

    return (
        <Pressable
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                height: 32,
                opacity: p.pressed ? 0.7 : 1,
                flex: 1,
                overflow: 'hidden',
            })}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                onPress?.();
            }}
        >
            {hasMeaningfulGitStatus ? (
                <GitStatusBadge sessionId={sessionId} />
            ) : (
                <Octicons
                    name="git-branch"
                    size={16}
                    color={theme.colors.button.secondary.tint}
                />
            )}
        </Pressable>
    );
}
