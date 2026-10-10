import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, StyleSheet, Text, View } from 'react-native';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { TaskListView } from './TaskListView';
import { computeMessageClusters, ClusterOptions, type TaskClusterMessage } from './clusterTimeline';
import { Metadata, Session } from '@/sync/storageTypes';
import { layout } from './layout';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { dividerKindFor, formatClock, formatDividerDate, type DividerKind } from '@/sync/messageDividers';
import { t } from '@/text';

/** One row of the list: the thing to draw, and the divider that belongs above it. */
type ChatRow = { node: Message | TaskClusterMessage; divider: DividerKind };

/**
 * A time divider above a group of messages, the way a chat app marks "when" without repeating a
 * clock on every bubble. Sits inside the row it belongs to, which on an inverted list is the row
 * above the message it labels.
 */
const TimeDivider = React.memo(({ kind, at }: { kind: DividerKind; at: number }) => {
    const { theme } = useUnistyles();
    const label = kind === 'yesterday'
        ? `${t('time.yesterday')} ${formatClock(at)}`
        : kind === 'date'
            ? `${formatDividerDate(at, Date.now())} ${formatClock(at)}`
            : formatClock(at);
    return (
        <View style={styles.dividerRow}>
            <Text style={[styles.dividerText, { color: theme.colors.textSecondary, backgroundColor: theme.colors.surfaceHigh }]}>{label}</Text>
        </View>
    );
});

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, hasOlderMessages, isLoadingOlder, isFetching } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            hasOlderMessages={hasOlderMessages}
            isLoadingOlder={isLoadingOlder}
            isFetching={isFetching}
            tasks={props.session.tasks}
        />
    )
});

const ListHeader = React.memo(() => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />;
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    )
});

/** Shown at the visual top of the inverted list while older messages are loading. */
const OlderMessagesLoader = React.memo(() => {
    const { theme } = useUnistyles();
    return (
        <View style={{ paddingVertical: 16, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        </View>
    );
});

/** Shown at the visual bottom of the inverted list while a fetchMessages call is in flight. */
const NewerMessagesLoader = React.memo(() => {
    const { theme } = useUnistyles();
    return (
        <View style={{ paddingBottom: 8, paddingTop: 4, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        </View>
    );
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
    hasOlderMessages: boolean,
    isLoadingOlder: boolean,
    isFetching: boolean,
    tasks: Session['tasks'],
}) => {
    const flatListRef = useRef<FlatList<ChatRow>>(null);
    // Track whether the user is near the visual bottom (newest messages).
    // In an inverted FlatList, offset 0 = visual bottom.
    const isNearBottomRef = useRef(true);
    const prevMessagesLengthRef = useRef(props.messages.length);

    const clusterOptions: ClusterOptions | undefined = useMemo(() => {
        if (!props.tasks || props.tasks.length === 0) return undefined;
        const m = new Map<string, string>();
        for (const t of props.tasks) {
            if (t.content) m.set(t.id, t.content);
        }
        return m.size > 0 ? { taskContentMap: m } : undefined;
    }, [props.tasks]);

    // Each row carries the divider that belongs above it. The list renders newest first and is
    // inverted, so the row *below* a message in the data is the older one — which is the neighbour
    // the divider is decided against.
    const rows = useMemo<ChatRow[]>(() => {
        const clustered = computeMessageClusters(props.messages, clusterOptions);
        const now = Date.now();
        return clustered.map((node, index) => {
            // Both ends of the loaded window always carry one, for the same reason in opposite
            // directions: the top is where the conversation continues past what is loaded, and the
            // bottom is the time of the latest thing said — the first thing a reader looks for, and
            // exactly what the pace rule hides while a conversation is moving.
            const older = index === 0 || index + 1 >= clustered.length
                ? null
                : clustered[index + 1].createdAt;
            return { node, divider: dividerKindFor(node.createdAt, older, now) };
        });
    }, [props.messages, clusterOptions]);

    const keyExtractor = useCallback((row: ChatRow) => row.node.id, []);
    const renderItem = useCallback(({ item: row }: { item: ChatRow }) => {
        const item = row.node;
        const divider = row.divider === 'none' ? null : <TimeDivider kind={row.divider} at={item.createdAt} />;
        if (item.kind === 'task-cluster') {
            return (
                <>
                    {divider}
                    <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
                        <View style={{ flexDirection: 'column', flexGrow: 1, flexBasis: 0, maxWidth: layout.maxWidth }}>
                            <View style={{ marginHorizontal: 8, marginBottom: 12 }}>
                                <TaskListView tasks={item.tasks} />
                            </View>
                        </View>
                    </View>
                </>
            );
        }
        return (
            <>
                {divider}
                <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />
            </>
        );
    }, [props.metadata, props.sessionId]);

    const handleEndReached = useCallback(() => {
        if (props.hasOlderMessages && !props.isLoadingOlder) {
            sync.fetchOlderMessages(props.sessionId);
        }
    }, [props.hasOlderMessages, props.isLoadingOlder, props.sessionId]);

    const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        isNearBottomRef.current = event.nativeEvent.contentOffset.y < 80;
    }, []);

    // Auto-scroll to newest messages when new ones arrive, if already near the bottom.
    useEffect(() => {
        const prev = prevMessagesLengthRef.current;
        const curr = props.messages.length;
        prevMessagesLengthRef.current = curr;
        if (curr > prev && isNearBottomRef.current) {
            flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
        }
    }, [rows]);

    // In an inverted FlatList:
    //   ListHeaderComponent → visual bottom (below newest message, above input)
    //   ListFooterComponent → visual top (above oldest message)
    // Memoize to prevent FlatList remounting the header on every render, which
    // would disrupt scroll position tracking.
    const listHeader = useMemo(() => (
        <>
            {props.isFetching && <NewerMessagesLoader />}
            <ListFooter sessionId={props.sessionId} />
        </>
    ), [props.isFetching, props.sessionId]);

    const listFooter = useMemo(() => (
        props.isLoadingOlder
            ? <><OlderMessagesLoader /><ListHeader /></>
            : <ListHeader />
    ), [props.isLoadingOlder]);

    return (
        <FlatList<ChatRow>
            ref={flatListRef}
            data={rows}
            inverted={true}
            keyExtractor={keyExtractor}
            // No maintainVisibleContentPosition here, deliberately. On an inverted list it defeats
            // windowing: it made the list mount far more cells than `windowSize` allows, and
            // opening a session spent ~1.3s building that extra window. An inverted list already
            // stays anchored at the newest message, and the effect below re-pins it explicitly,
            // so it was buying nothing.
            //
            // Measured on device when opening a ~2000 message session — cells actually mounted
            // fell from ~60 to 24 and the fill burst from ~1277ms to ~270ms.
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
            renderItem={renderItem}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.3}
            onScroll={handleScroll}
            scrollEventThrottle={100}
            ListHeaderComponent={listHeader}
            ListFooterComponent={listFooter}
            // A busy session is thousands of messages and nothing here had ever been tuned, so
            // FlatList's defaults applied: 10 to start, 10 per batch, and a 21-viewport window —
            // neither the mount nor the per-batch reconcile proportional to what is on screen.
            // These bound it to roughly the visible area. (The cells themselves turned out to be
            // cheap to render — markdown parse and syntax tokenize measure ~0ms — so the cost was
            // the window's size, not any one cell.)
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            updateCellsBatchingPeriod={50}
            windowSize={7}
        />
    )
});

const styles = StyleSheet.create({
    dividerRow: {
        alignItems: 'center',
        paddingVertical: 10,
    },
    dividerText: {
        fontSize: 12,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
        overflow: 'hidden',
    },
});
