import * as React from 'react';
import { View, Text, StyleSheet, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Avatar } from '@/components/Avatar';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight, useHasSidebar } from '@/utils/responsive';
import { layout } from '@/components/layout';
import { useUnistyles } from 'react-native-unistyles';
import { useSidebar } from './SidebarContext';
import { isRunningInTauri } from '@/utils/platform';
import { DESKTOP_SIDEBAR_WIDTH } from './SidebarNavigator';

interface ChatHeaderViewProps {
    title: string;
    subtitle?: string;
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
    onBackPress,
    onAvatarPress,
    avatarId,
    isConnected = true,
    flavor,
}) => {
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const hasSidebar = useHasSidebar();
    const sidebar = useSidebar();

    const handleBackPress = () => {
        if (onBackPress) {
            onBackPress();
        } else {
            navigation.goBack();
        }
    };

    // Sidebar toggle with Tauri window resize sequenced correctly:
    //   Expand → resize window first (grows left), then show sidebar (no content shrink flash)
    //   Collapse → hide sidebar first, then resize window (no content grow flash... minimal)
    const handleSidebarToggle = React.useCallback(() => {
        if (!sidebar) return;
        const willCollapse = !sidebar.isCollapsed;

        if (!isRunningInTauri()) {
            sidebar.toggleSidebar();
            return;
        }

        (async () => {
            try {
                const [{ getCurrentWindow }, { PhysicalSize, PhysicalPosition }] = await Promise.all([
                    import('@tauri-apps/api/window'),
                    import('@tauri-apps/api/dpi'),
                ]);
                const win = getCurrentWindow();

                if (willCollapse) {
                    // Hide sidebar first so content area is consistent before window shrinks.
                    sidebar.setIsCollapsed(true);
                    const [physSize, physPos, scale] = await Promise.all([
                        win.outerSize(), win.outerPosition(), win.scaleFactor(),
                    ]);
                    const physDelta = Math.round(DESKTOP_SIDEBAR_WIDTH * scale);
                    await Promise.all([
                        win.setSize(new PhysicalSize(physSize.width - physDelta, physSize.height)),
                        win.setPosition(new PhysicalPosition(physPos.x + physDelta, physPos.y)),
                    ]);
                } else {
                    // Grow window first so the sidebar has room when it mounts.
                    const [physSize, physPos, scale] = await Promise.all([
                        win.outerSize(), win.outerPosition(), win.scaleFactor(),
                    ]);
                    const physDelta = Math.round(DESKTOP_SIDEBAR_WIDTH * scale);
                    const newX = Math.max(0, physPos.x - physDelta);
                    const actualDelta = physPos.x - newX;
                    await Promise.all([
                        win.setSize(new PhysicalSize(physSize.width + actualDelta, physSize.height)),
                        win.setPosition(new PhysicalPosition(newX, physPos.y)),
                    ]);
                    // Show sidebar after window is already the right size.
                    sidebar.setIsCollapsed(false);
                }
            } catch (e) {
                console.error('[ChatHeaderView] sidebar resize failed:', e);
                sidebar.toggleSidebar();
            }
        })();
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
                    {subtitle && (
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[
                                styles.subtitle,
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
    avatarButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: Platform.select({ ios: -8, default: -8 }),
    },
});