import React from 'react';
import { View, Pressable, SectionList, Platform, ActivityIndicator } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, useSessionIsFetching } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionSubtitle, getSessionAvatarId, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { ActiveSessionsGroup } from './ActiveSessionsGroup';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSetting } from '@/sync/storage';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { StatusDot } from './StatusDot';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { layout } from './layout';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { useHappyAction } from '@/hooks/useHappyAction';
import { sessionDelete } from '@/sync/ops';
import { HappyError } from '@/utils/errors';
import { Modal } from '@/modal';
import { SessionRowStatusIndicators } from './SessionRowStatusIndicators';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    headerSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    projectGroup: {
        paddingLeft: 4,
        paddingRight: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.groupped.background,
    },
    projectGroupTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    projectGroupSubtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    hostGroup: {
        paddingHorizontal: 16,
        paddingTop: 6,
        paddingBottom: 2,
        backgroundColor: theme.colors.groupped.background,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
    },
    hostGroupText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    hostGroupCount: {
        fontSize: 9,
        color: theme.colors.textSecondary,
        marginLeft: 6,
        ...Typography.default(),
    },
    sessionItem: {
        height: 88,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.surface,
    },
    sessionItemContainer: {
        marginHorizontal: 16,
        overflow: 'hidden',
    },
    sessionItemFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 4,
    },
    sessionItemSingle: {
        borderRadius: 12,
    },
    sessionItemContainerFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemContainerLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 4,
    },
    sessionItemContainerSingle: {
        borderRadius: 12,
        marginBottom: 4,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        marginLeft: 16,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 2,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        ...Typography.default(),
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    avatarContainer: {
        position: 'relative',
        width: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconContainer: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconOverlay: {
        color: theme.colors.textSecondary,
    },
    artifactsSection: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        backgroundColor: theme.colors.groupped.background,
    },
    swipeAction: {
        width: 112,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        color: '#FFFFFF',
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    fetchingIndicator: {
        marginLeft: 6,
        flexShrink: 0,
    },
}));

export function SessionsList() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const data = useVisibleSessionListViewData();
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const navigateToSession = useNavigateToSession();
    const compactSessionView = useSetting('compactSessionView');
    const router = useRouter();
    const selectable = isTablet;
    const experiments = useSetting('experiments');
    // Always call useMemo unconditionally to satisfy Rules of Hooks.
    // When selectable is false the memo result is discarded in favour of raw data.
    const dataWithSelectedMemo = React.useMemo(() => {
        if (!selectable || !data) return null;
        return data.map(item => ({
            ...item,
            selected: pathname.startsWith(`/session/${item.type === 'session' ? item.session.id : ''}`)
        }));
    }, [selectable, data, pathname]);
    const dataWithSelected = selectable ? dataWithSelectedMemo : data;

    // Track which project groups are collapsed
    const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(new Set());
    // Track which host groups have offline sessions hidden (key: "projectPath|host")
    const [hiddenOfflineHosts, setHiddenOfflineHosts] = React.useState<Set<string>>(new Set());

    // Filter out items inside collapsed project groups and hidden offline sessions
    const visibleData = React.useMemo(() => {
        if (!dataWithSelected) return null;
        const result: typeof dataWithSelected = [];
        let skipUntilNextProject = false;
        let currentProjectPath = '';
        let currentHost = '';
        let hideOffline = false;

        for (const item of dataWithSelected) {
            if (item.type === 'worktree-group') {
                currentProjectPath = item.projectPath;
                skipUntilNextProject = collapsedProjects.has(item.projectPath);
                result.push(item);
                continue;
            }
            if (item.type === 'host-group') {
                currentHost = item.host;
                hideOffline = hiddenOfflineHosts.has(currentProjectPath + '|' + item.host);
                if (!skipUntilNextProject) result.push(item);
                continue;
            }
            if (skipUntilNextProject) continue;
            if (item.type === 'session' && hideOffline && currentHost && !item.session.active) continue;
            result.push(item);
        }
        return result;
    }, [dataWithSelected, collapsedProjects, hiddenOfflineHosts]);

    // Convert visibleData into sections for SectionList. Each worktree-group
    // becomes a section header; items before the first worktree-group go into a
    // preamble section with an invisible header.
    interface Section {
        header: SessionListViewItem & { selected?: boolean } | null;
        data: (SessionListViewItem & { selected?: boolean })[];
    }
    const sections: Section[] = React.useMemo(() => {
        if (!visibleData) return [];
        const result: Section[] = [];
        let current: Section = { header: null, data: [] };
        for (const item of visibleData) {
            if (item.type === 'worktree-group') {
                if (current.header !== null || current.data.length > 0) {
                    result.push(current);
                }
                current = { header: item, data: [] };
            } else {
                current.data.push(item);
            }
        }
        if (current.header !== null || current.data.length > 0) {
            result.push(current);
        }
        return result;
    }, [visibleData]);


    const renderSectionHeader = React.useCallback(({ section }: { section: { header: SessionListViewItem & { selected?: boolean } | null } }) => {
        if (!section.header) return null;
        const item = section.header;
        if (item.type !== 'worktree-group') return null;
        const isCollapsed = collapsedProjects.has(item.projectPath);
        return (
            <Pressable
                onPress={() => setCollapsedProjects(prev => {
                    const next = new Set(prev);
                    if (next.has(item.projectPath)) next.delete(item.projectPath);
                    else next.add(item.projectPath);
                    return next;
                })}
                style={({ pressed }) => [
                    styles.projectGroup,
                    { flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.7 : 1 },
                ]}
            >
                <Ionicons name={isCollapsed ? "chevron-forward" : "chevron-down"} size={14} color="#8E8E93" style={{ marginRight: 6 }} />
                <Ionicons name="folder-outline" size={14} color="#8E8E93" style={{ marginRight: 8 }} />
                <Text style={styles.projectGroupTitle} numberOfLines={1}>
                    {item.projectPath
                        ? formatPathRelativeToHome(item.projectPath, item.homeDir)
                        : item.branch || 'Other'}
                </Text>
            </Pressable>
        );
    }, [collapsedProjects, styles.projectGroup, styles.projectGroupTitle]);

        // Request review
    React.useEffect(() => {
        if (data && data.length > 0) {
            requestReview();
        }
    }, [data && data.length > 0]);

    // Early return if no data yet
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    const keyExtractor = React.useCallback((item: SessionListViewItem & { selected?: boolean }, index: number) => {
        switch (item.type) {
            case 'header': return `header-${item.title}-${index}`;
            case 'active-sessions': return 'active-sessions';
            case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
            case 'host-group': return `host-group-${item.projectPath}-${item.host}-${index}`;
            case 'session': return `session-${item.session.id}-${index}`;
            default: return `item-${index}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item, index }: { item: SessionListViewItem & { selected?: boolean }, index: number }) => {
        switch (item.type) {
            case 'header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>
                            {item.title}
                        </Text>
                    </View>
                );

            case 'active-sessions':
                // Extract just the session ID from pathname (e.g., /session/abc123/file -> abc123)
                let selectedId: string | undefined;
                if (isTablet && pathname.startsWith('/session/')) {
                    const parts = pathname.split('/');
                    selectedId = parts[2]; // parts[0] is empty, parts[1] is 'session', parts[2] is the ID
                }

                const ActiveComponent = compactSessionView ? ActiveSessionsGroupCompact : ActiveSessionsGroup;
                return (
                    <ActiveComponent
                        sessions={item.sessions}
                        selectedSessionId={selectedId}
                    />
                );

            case 'project-group':
                return (
                    <View style={styles.projectGroup}>
                        <Text style={styles.projectGroupTitle}>
                            {item.displayPath}
                        </Text>
                        <Text style={styles.projectGroupSubtitle}>
                            {item.machine.metadata?.displayName || item.machine.metadata?.host || item.machine.id}
                        </Text>
                    </View>
                );


            case 'host-group': {
                const hostKey = item.projectPath + '|' + item.host;
                const isHidingOffline = hiddenOfflineHosts.has(hostKey);
                const hasOffline = item.totalCount > item.onlineCount;
                return (
                    <Pressable
                        onPress={hasOffline ? () => setHiddenOfflineHosts(prev => {
                            const next = new Set(prev);
                            if (next.has(hostKey)) next.delete(hostKey);
                            else next.add(hostKey);
                            return next;
                        }) : undefined}
                        style={({ pressed }) => [
                            styles.hostGroup,
                            { opacity: hasOffline && pressed ? 0.7 : 1 },
                        ]}
                    >
                        <Text style={styles.hostGroupText} numberOfLines={1}>
                            {item.host || 'Unknown'}{' · '}{item.onlineCount}/{item.totalCount} online{hasOffline ? (isHidingOffline ? ' ▸' : ' ▾') : ''}
                        </Text>
                    </Pressable>
                );
            }

            case 'session':
                // Determine card styling based on position within date group
                const prevItem = index > 0 && visibleData ? visibleData[index - 1] : null;
                const nextItem = index < (visibleData?.length || 0) - 1 && visibleData ? visibleData[index + 1] : null;

                const isGroupBoundary = (type: string) => type === 'header' || type === 'host-group' || type === 'worktree-group' || type === 'active-sessions';
                const isFirst = prevItem ? isGroupBoundary(prevItem.type) : true;
                const isLast = nextItem ? isGroupBoundary(nextItem.type) : true;
                const isSingle = isFirst && isLast;

                return (
                    <SessionItem
                        session={item.session}
                        selected={item.selected}
                        isFirst={isFirst}
                        isLast={isLast}
                        isSingle={isSingle}
                    />
                );
        }
    }, [pathname, visibleData, compactSessionView, collapsedProjects, hiddenOfflineHosts]);


    // Remove this section as we'll use FlatList for all items now


    const HeaderComponent = React.useCallback(() => {
        return (
            <UpdateBanner />
        );
    }, []);

    // Footer removed - all sessions now shown inline

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <View style={{ flex: 1 }}>
                    <SectionList
                        sections={sections}
                        renderItem={renderItem}
                        renderSectionHeader={renderSectionHeader}
                        keyExtractor={keyExtractor}
                        contentContainerStyle={{ paddingBottom: safeArea.bottom + 128, maxWidth: layout.maxWidth }}
                        ListHeaderComponent={HeaderComponent}
                        stickySectionHeadersEnabled={true}
                    />
                </View>
            </View>
        </View>
    );
}

// Sub-component that handles session message logic
const SessionItem = React.memo(({ session, selected, isFirst, isLast, isSingle }: {
    session: Session;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
}) => {
    const styles = stylesheet;
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const isFetching = useSessionIsFetching(session.id);
    const sessionSubtitle = getSessionSubtitle(session);
    const isWorktree = session.metadata?.isWorktree === true;
    const avatarSize = isWorktree ? 36 : 48;
    const navigateToSession = useNavigateToSession();
    const isTablet = useIsTablet();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const swipeEnabled = Platform.OS !== 'web';

    const [deletingSession, performDelete] = useHappyAction(async () => {
        const result = await sessionDelete(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToDeleteSession'), false);
        }
    });

    const handleDelete = React.useCallback(() => {
        swipeableRef.current?.close();
        Modal.alert(
            t('sessionInfo.deleteSession'),
            t('sessionInfo.deleteSessionWarning'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.deleteSession'),
                    style: 'destructive',
                    onPress: performDelete
                }
            ]
        );
    }, [performDelete]);

    const avatarId = React.useMemo(() => {
        return getSessionAvatarId(session);
    }, [session]);

    const itemContent = (
        <Pressable
            style={[
                styles.sessionItem,
                selected && styles.sessionItemSelected,
                isSingle ? styles.sessionItemSingle :
                    isFirst ? styles.sessionItemFirst :
                        isLast ? styles.sessionItemLast : {}
            ]}
            onPressIn={() => {
                if (isTablet) {
                    navigateToSession(session.id);
                }
            }}
            onPress={() => {
                if (!isTablet) {
                    navigateToSession(session.id);
                }
            }}
        >
            <View style={styles.avatarContainer}>
                <Avatar id={avatarId} size={avatarSize} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} />
                {session.draft && (
                    <View style={styles.draftIconContainer}>
                        <Ionicons
                            name="create-outline"
                            size={12}
                            style={styles.draftIconOverlay}
                        />
                    </View>
                )}
            </View>
            <View style={styles.sessionContent}>
                {/* Title line */}
                <View style={styles.sessionTitleRow}>
                    <Text style={[
                        styles.sessionTitle,
                        sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected,
                        isWorktree && { fontSize: 13 }
                    ]} numberOfLines={1}>
                        {sessionName}
                    </Text>
                    <SessionRowStatusIndicators session={session} />
                    {isFetching && (
                        <ActivityIndicator size="small" style={styles.fetchingIndicator} />
                    )}
                </View>

                {/* Subtitle line */}
                <Text style={[styles.sessionSubtitle, isWorktree && { fontSize: 11 }]} numberOfLines={1}>
                    {sessionSubtitle}
                </Text>

                {/* Status line with dot */}
                <View style={styles.statusRow}>
                    <View style={styles.statusDotContainer}>
                        <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                    </View>
                    <Text style={[
                        styles.statusText,
                        { color: sessionStatus.statusColor }
                    ]}>
                        {sessionStatus.statusText}
                    </Text>
                </View>
            </View>
        </Pressable>
    );

    const containerStyles = [
        styles.sessionItemContainer,
        isSingle ? styles.sessionItemContainerSingle :
            isFirst ? styles.sessionItemContainerFirst :
                isLast ? styles.sessionItemContainerLast : {}
    ];

    if (!swipeEnabled) {
        return (
            <View style={containerStyles}>
                {itemContent}
            </View>
        );
    }

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeAction}
            onPress={handleDelete}
            disabled={deletingSession}
        >
            <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
            <Text style={styles.swipeActionText} numberOfLines={2}>
                {t('sessionInfo.deleteSession')}
            </Text>
        </Pressable>
    );

    return (
        <View style={containerStyles}>
            <Swipeable
                ref={swipeableRef}
                renderRightActions={renderRightActions}
                overshootRight={false}
                enabled={!deletingSession}
            >
                {itemContent}
            </Swipeable>
        </View>
    );
});
