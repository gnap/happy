import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, View } from 'react-native';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { TaskListView } from './TaskListView';
import { computeMessageClusters, ClusterOptions } from './clusterTimeline';
import { Metadata, Session } from '@/sync/storageTypes';
import { layout } from './layout';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';

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
    const flatListRef = useRef<FlatList>(null);
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

    const messagesWithTasks = useMemo(
        () => {
            // DIAGNOSTIC: dump message structure info to global for connector access
            const tcMessages = props.messages.filter(m => m.kind === 'tool-call' && (m.tool?.name === 'TaskCreate' || m.tool?.name === 'TaskUpdate'));
            try { localStorage.setItem('__cluster_diag__', JSON.stringify({ msgCount: props.messages.length, taskMsgCount: tcMessages.length, hasTasks: !!props.tasks?.length, taskCount: props.tasks?.length, firstTC: tcMessages.slice(0,2).map(m => ({ name: m.tool?.name, inputKeys: Object.keys(m.tool?.input || {}), sampleInput: JSON.stringify(m.tool?.input).slice(0,300) })), time: Date.now() })); } catch {}
            return computeMessageClusters(props.messages, clusterOptions);
        },
        [props.messages, clusterOptions],
    );

    const keyExtractor = useCallback((item: any) => item.id, []);
    const renderItem = useCallback(({ item }: { item: any }) => {
        if (item.kind === 'task-cluster') {
            return (
                <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
                    <View style={{ flexDirection: 'column', flexGrow: 1, flexBasis: 0, maxWidth: layout.maxWidth }}>
                        <View style={{ marginHorizontal: 8, marginBottom: 12 }}>
                            <TaskListView tasks={item.tasks} />
                        </View>
                    </View>
                </View>
            );
        }
        return <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />;
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
    }, [messagesWithTasks]);

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
        <FlatList
            ref={flatListRef}
            data={messagesWithTasks}
            inverted={true}
            keyExtractor={keyExtractor}
            maintainVisibleContentPosition={{
                minIndexForVisible: 0,
                autoscrollToTopThreshold: 10,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
            renderItem={renderItem}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.3}
            onScroll={handleScroll}
            scrollEventThrottle={100}
            ListHeaderComponent={listHeader}
            ListFooterComponent={listFooter}
        />
    )
});