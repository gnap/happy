import * as React from 'react';
import { View, Text, StyleSheet, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Avatar } from '@/components/Avatar';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight, useHasSidebar } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { useUnistyles } from 'react-native-unistyles';
import { useSidebar } from './SidebarContext';

interface ChatHeaderViewProps {
    title: string;
    subtitle?: string;
    rightSubtitle?: string;
    onBackPress?: () => void;
    onAvatarPress?: () => void;
    avatarId?: string;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    flavor?: string | null;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    subtitle,
    rightSubtitle,
    onBackPress,
    onAvatarPress,
    avatarId,
    isConnected = true,
    flavor,
}) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const hasSidebar = useHasSidebar();
    const sidebar = useSidebar();

    const handleBackPress = () => {
        if (onBackPress) {
            onBackPress();
        } else {
            router.back();
        }
    };

    const handleSidebarToggle = React.useCallback(() => {
        sidebar?.toggleSidebar();
    }, [sidebar]);

    return (
        <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.header.background }]}>
            <View style={styles.contentWrapper}>
                <View style={[styles.content, { height: headerHeight }]}>
                {hasSidebar && sidebar ? (
                    <Pressable onPress={handleSidebarToggle} style={styles.backButton} hitSlop={15}>
                        <Ionicons
                            name={sidebar.isCollapsed ? 'menu-outline' : 'arrow-back-circle-outline'}
                            size={24}
                            color={theme.colors.header.tint}
                        />
                    </Pressable>
                ) : (
                    <Pressable onPress={handleBackPress} style={styles.backButton} hitSlop={15}>
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color={theme.colors.header.tint}
                        />
                    </Pressable>
                )}
                
                <View style={styles.titleContainer}>
                    <Text
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        style={[
                            styles.title,
                            {
                                color: theme.colors.header.tint,
                                ...Typography.default('semiBold')
                            }
                        ]}
                    >
                        {title}
                    </Text>
                    {(subtitle || rightSubtitle) && (
                        <View style={styles.subtitleRow}>
                            {subtitle && (
                                <Text
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    style={[
                                        styles.subtitle,
                                        { flex: 1 },
                                        {
                                            color: theme.colors.header.tint,
                                            opacity: 0.7,
                                            ...Typography.default()
                                        }
                                    ]}
                                >
                                    {subtitle}
                                </Text>
                            )}
                            {rightSubtitle && (
                                <Text
                                    numberOfLines={1}
                                    style={[
                                        styles.subtitle,
                                        {
                                            color: theme.colors.header.tint,
                                            opacity: 0.5,
                                            ...Typography.default()
                                        }
                                    ]}
                                >
                                    {rightSubtitle}
                                </Text>
                            )}
                        </View>
                    )}
                </View>
                
                {avatarId && onAvatarPress && (
                    <Pressable
                        onPress={onAvatarPress}
                        hitSlop={15}
                        style={styles.avatarButton}
                    >
                        <Avatar
                            id={avatarId}
                            size={32}
                            monochrome={!isConnected}
                            flavor={flavor}
                        />
                    </Pressable>
                )}
                </View>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.OS === 'ios' ? 8 : 16,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
    },
    backButton: {
        marginRight: 8,
    },
    titleContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
    },
    title: {
        fontSize: Platform.select({
            ios: 15,
            android: 15,
            default: 16
        }),
        fontWeight: '600',
        marginBottom: 1,
        width: '100%',
    },
    subtitle: {
        fontSize: 12,
        fontWeight: '400',
        lineHeight: 14,
    },
    subtitleRow: {
        flexDirection: 'row',
        width: '100%',
    },
    avatarButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: Platform.select({ ios: -8, default: -8 }),
    },
});
