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

    // TaskCreate/TaskUpdate cards are rendered individually via TaskTrackerView
    // (rich colored status). Only intermediate tool calls are collapsed.
    const messagesWithTasks = useMemo(() => {
        const taskNames = new Set(['TaskCreate', 'TaskUpdate']);
        const result: any[] = [];
        let i = 0;
        while (i < props.messages.length) {
            const msg = props.messages[i] as any;
            const isTaskCreate = msg.kind === 'tool-call' && msg.tool?.name === 'TaskCreate';
            if (isTaskCreate) {
                // Enter task mode — collect intermediate tool calls for collapse,
                // while letting TaskCreate/TaskUpdate pass through as individual cards.
                const collapsedMsgs: any[] = [];
                while (i < props.messages.length) {
                    const m = props.messages[i] as any;
                    if (m.kind === 'tool-call' && taskNames.has(m.tool?.name)) {
                        // TaskCreate/TaskUpdate — pass through individually
                        result.push(m);
                        i++;
                    } else if (m.kind === 'tool-call' || m.kind === 'agent-text') {
                        // Intermediate tool call or text — collapse
                        collapsedMsgs.push(m);
                        i++;
                    } else {
                        // User message, event, or other — exit task mode
                        break;
                    }
                }
                // Emit collapse card for intermediate tool calls (not task msgs themselves)
                const collapsedToolCount = collapsedMsgs.filter(
                    (m: any) => m.kind === 'tool-call'
                ).length;
                if (collapsedToolCount > 0) {
                    result.push({
                        id: collapsedMsgs[0]?.id ?? result[result.length - 1]?.id ?? '',
                        kind: 'task-cluster',
                        tasks: undefined,
                        collapsedCount: collapsedToolCount,
                        createdAt: collapsedMsgs[0]?.createdAt ?? Date.now(),
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
                            <TaskListView tasks={item.tasks} collapsedCount={item.collapsedCount} />
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