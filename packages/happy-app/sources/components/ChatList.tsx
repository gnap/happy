import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
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

/** How long the newest message's time stays out after the pull that revealed it settles. */
const SETTLE_HOLD_MS = 1200;

/**
 * One row of the list: the thing to draw, and the divider that belongs to it. A row's divider is
 * drawn above it, except for the newest message — whose time belongs *below* it, at the end of the
 * content, so that it is out of the way while the conversation is being read and appears when the
 * reader scrolls back.
 */
type ChatRow = { node: Message | TaskClusterMessage; divider: DividerKind; dividerBelow: boolean };

/**
 * A time divider above a group of messages, the way a chat app marks "when" without repeating a
 * clock on every bubble. Sits inside the row it belongs to, which on an inverted list is the row
 * above the message it labels.
 */
const TimeDivider = React.memo(({ kind, at, hidden = false }: { kind: DividerKind; at: number; hidden?: boolean }) => {
    const { theme } = useUnistyles();
    const opacity = useSharedValue(hidden ? 0 : 1);
    useEffect(() => {
        opacity.value = withTiming(hidden ? 0 : 1, { duration: 160 });
    }, [hidden, opacity]);
    const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
    const label = kind === 'yesterday'
        ? `${t('time.yesterday')} ${formatClock(at)}`
        : kind === 'date'
            ? `${formatDividerDate(at, Date.now())} ${formatClock(at)}`
            : formatClock(at);
    return (
        // `hidden` rather than unmounted: the label below the newest message holds its place whether
        // or not it is being shown, so a reader taking hold of the list does not see the last bubble
        // shift by the height of a label that appeared under their finger.
        <Animated.View style={[styles.dividerRow, fade]}>
            <Text style={[styles.dividerText, { color: theme.colors.textSecondary, backgroundColor: theme.colors.surfaceHigh }]}>{label}</Text>
        </Animated.View>
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

    /**
     * Whether the time below the newest message is being shown.
     *
     * It is a thing the reader *asks for*, and the ask is the pull that goes past the end of the
     * conversation — on iOS the rubber band that is that gesture's own feedback. An inverted list
     * cannot be asked "are you near the end" to find this: at rest and at the bottom of a pull both
     * read as `y < 80`. The pull itself is unmistakable, though — the offset goes *past* zero —
     * which is the one signal that separates the two.
     *
     * Once it is out it stays for a beat after the pull settles, because the time is the thing the
     * reader pulled for and a label that vanishes with the bounce is one they have to pull again to
     * read.
     */
    const [revealed, setRevealed] = React.useState(false);
    const revealedRef = useRef(false);
    const draggingRef = useRef(false);
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Each row carries the divider that belongs above it. The list renders newest first and is
    // inverted, so the row *below* a message in the data is the older one — which is the neighbour
    // the divider is decided against.
    const rows = useMemo<ChatRow[]>(() => {
        const clustered = computeMessageClusters(props.messages, clusterOptions);
        const now = Date.now();
        return clustered.map((node, index) => {
            // Both ends of the loaded window always carry a divider, for the same reason in opposite
            // directions: the top is where the conversation continues past what this device holds,
            // and the bottom is the time of the latest thing said — the first thing a reader looks
            // for, and exactly what the pace rule hides while a conversation is moving.
            const newest = index === 0;
            const older = newest || index + 1 >= clustered.length
                ? null
                : clustered[index + 1].createdAt;
            return { node, divider: dividerKindFor(node.createdAt, older, now), dividerBelow: newest };
        });
    }, [props.messages, clusterOptions]);

    const keyExtractor = useCallback((row: ChatRow) => row.node.id, []);
    const renderItem = useCallback(({ item: row }: { item: ChatRow }) => {
        const item = row.node;
        // A divider above a row is there for the message it labels, so it lives and dies with it.
        // The newest message's time is the reader's to ask for, so it is always mounted and shown
        // only when they do — see `revealed`.
        const divider = row.divider !== 'none' ? <TimeDivider kind={row.divider} at={item.createdAt} /> : null;
        const bottomDivider = row.divider !== 'none'
            ? <TimeDivider kind={row.divider} at={item.createdAt} hidden={!revealed} />
            : null;
        if (item.kind === 'task-cluster') {
            return (
                <>
                    {!row.dividerBelow && divider}
                    <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
                        <View style={{ flexDirection: 'column', flexGrow: 1, flexBasis: 0, maxWidth: layout.maxWidth }}>
                            <View style={{ marginHorizontal: 8, marginBottom: 12 }}>
                                <TaskListView tasks={item.tasks} />
                            </View>
                        </View>
                    </View>
                {row.dividerBelow && bottomDivider}
                </>
            );
        }
        return (
            <>
                {!row.dividerBelow && divider}
                <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />
                {row.dividerBelow && bottomDivider}
            </>
        );
    }, [props.metadata, props.sessionId, revealed]);

    const handleEndReached = useCallback(() => {
        if (props.hasOlderMessages && !props.isLoadingOlder) {
            sync.fetchOlderMessages(props.sessionId);
        }
    }, [props.hasOlderMessages, props.isLoadingOlder, props.sessionId]);

    /**
     * How long the time stays out after the pull settles.
     *
     * Long enough to read a clock, short enough that it is gone by the time the reader is reading
     * the conversation again — the label is a peek, not a resident.
     */
    /**
     * Shows or hides the time, once per change.
     *
     * The scroll handler runs on every frame of every gesture, so the state is set only when it
     * differs from what is already on screen — and the log line rides on that same edge, which makes
     * the log a record of the reader's gesture rather than of the scroll position.
     */
    const setReveal = useCallback((next: boolean, why: string) => {
        if (revealedRef.current === next) {
            return;
        }
        revealedRef.current = next;
        console.log(`🕘 chat bottom time: ${next ? 'shown' : 'hidden'} (${why})`);
        setRevealed(next);
    }, []);

    const clearSettleTimer = useCallback(() => {
        if (settleTimerRef.current !== null) {
            clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
        }
    }, []);

    const scheduleSettle = useCallback(() => {
        if (settleTimerRef.current !== null) {
            return;
        }
        settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            setReveal(false, 'settled at the end');
        }, SETTLE_HOLD_MS);
    }, [setReveal]);

    useEffect(() => clearSettleTimer, [clearSettleTimer]);

    const handleDragBegin = useCallback(() => {
        draggingRef.current = true;
    }, []);

    const handleDragEnd = useCallback(() => {
        draggingRef.current = false;
    }, []);

    const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const y = event.nativeEvent.contentOffset.y;
        const near = y < 80;
        isNearBottomRef.current = near;
        // Past the end: the offset leaves zero in the direction there is no content in. On an
        // inverted list that is `y < 0` — the rubber band — and where a list does not bounce, a
        // finger held at the end is the same gesture seen from further away.
        const pulled = y < -4 || (draggingRef.current && y < 8);
        // Only on a change, and only the direction that matters: this runs on every scroll frame.
        if (pulled || !near) {
            clearSettleTimer();
            setReveal(true, pulled ? `pulled past the end, y=${Math.round(y)}` : `scrolled back, y=${Math.round(y)}`);
        } else {
            scheduleSettle();
        }
    }, [clearSettleTimer, scheduleSettle, setReveal]);

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
            onScrollBeginDrag={handleDragBegin}
            onScrollEndDrag={handleDragEnd}
            onMomentumScrollEnd={handleDragEnd}
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
