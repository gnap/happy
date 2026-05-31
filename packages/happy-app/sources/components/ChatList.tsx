import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, View } from 'react-native';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { TaskListView } from './TaskListView';
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

    // Collapse TaskCreate → [work] → TaskUpdate batches into a single timeline card.
    // Each task gets a top-level node (title) + one child node (execution status).
    const messagesWithTasks = useMemo(() => {
        const taskNames = new Set(['TaskCreate', 'TaskUpdate']);
        const result: any[] = [];
        let i = 0;
        while (i < props.messages.length) {
            const msg = props.messages[i] as any;
            const isTaskCreate = msg.kind === 'tool-call' && msg.tool?.name === 'TaskCreate';
            if (isTaskCreate) {
                const taskItems: { id: string; content: string; status: string; collapsedCount: number }[] = [];
                let currentTaskIdx = -1;
                let clusterStartId = msg.id;
                let clusterStartTime = msg.createdAt;
                while (i < props.messages.length) {
                    const m = props.messages[i] as any;
                    if (m.kind === 'tool-call' && m.tool?.name === 'TaskCreate') {
                        const input = m.tool?.input || {};
                        const content = input.description || input.subject || input.activeForm || '';
                        taskItems.push({ id: String(taskItems.length + 1), content, status: 'pending', collapsedCount: 0 });
                        currentTaskIdx = taskItems.length - 1;
                        i++;
                    } else if (m.kind === 'tool-call' && m.tool?.name === 'TaskUpdate') {
                        const input = m.tool?.input || {};
                        const tid = input.taskId || input.id || '';
                        const idx = parseInt(tid, 10) - 1;
                        console.log('[task-cluster] TaskUpdate input=', JSON.stringify(input), 'tid=', tid, 'idx=', idx, 'status=', input.status);
                        if (!isNaN(idx) && idx >= 0 && idx < taskItems.length) {
                            taskItems[idx].status = input.status || taskItems[idx].status;
                        }
                        currentTaskIdx = idx >= 0 && idx < taskItems.length ? idx : currentTaskIdx;
                        i++;
                    } else if (m.kind === 'tool-call' || m.kind === 'agent-text') {
                        // Intermediate tool calls / text — count towards current task
                        if (m.kind === 'tool-call' && currentTaskIdx >= 0 && currentTaskIdx < taskItems.length) {
                            taskItems[currentTaskIdx].collapsedCount++;
                        }
                        i++;
                    } else {
                        // User message, event, or other — exit task mode
                        break;
                    }
                }
                if (taskItems.length > 0) {
                    console.log('[task-cluster] emitting cluster with tasks=', JSON.stringify(taskItems));
                    result.push({
                        id: clusterStartId,
                        kind: 'task-cluster',
                        tasks: taskItems,
                        createdAt: clusterStartTime,
                    });
                }
            } else {
                result.push(msg);
                i++;
            }
        }
        return result;
    }, [props.messages]);

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